import { Logger } from '@nestjs/common';
import { toSatang } from '@inblack/domain';
import type pg from 'pg';
import { backoffMs, type OutboxConfig } from './outbox-config.js';
import {
  beginAttempt,
  closeOnly,
  completeFulfillment,
  countPosts,
  failFulfillment,
  finishAttempt,
  giveUpOnRefund,
  loadOrder,
  loadRefund,
  markDelivered,
  rejectRefund,
  reschedule,
  sendFulfillmentToReview,
  settleRefund,
  type Job,
} from './outbox.repository.js';
import type { GameClient, PayClient } from './provider-clients.js';

const logger = new Logger('OutboxJobs');

export interface HandlerDeps {
  pool: pg.Pool;
  game: GameClient;
  pay: PayClient;
  config: OutboxConfig;
}

/** One reference per order line: mock-game takes one sku per POST and counts per reference. */
export function referenceFor(orderId: string, sku: string): string {
  return `${orderId}:${sku}`;
}

/**
 * The rule that stops a double top-up (spec 5.4 invariant 2, ADR 0002): POST only straight after
 * a GET answered 404. Anything other than a clear 404 or a clear delivery means we do not know,
 * and not knowing never leads to a POST.
 */
export async function runFulfillment(deps: HandlerDeps, job: Job): Promise<void> {
  const { pool, game, config } = deps;
  const order = await loadOrder(pool, job.aggregateId);
  if (!order || order.status !== 'IN_PROGRESS') {
    await closeOnly(pool, job, 'order is not in progress');
    return;
  }

  // The last claim only reads. This way the final decision always rests on a fresh GET that
  // comes after the settle time of the last POST.
  const lastClaim = job.attempts >= config.maxAttempts;

  const retryLater = async (reason: string, mayStillLand: boolean) => {
    if (lastClaim) {
      await sendFulfillmentToReview(pool, job, `could not confirm the top-up: ${reason}`);
      return;
    }
    const delay =
      backoffMs(job.attempts, config.backoffBaseMs, config.backoffCapMs) +
      (mayStillLand ? config.settleMs : 0);
    await reschedule(pool, job, delay, reason);
  };

  let delivered = 0;
  let notDelivered = 0;
  for (const item of order.items) {
    const reference = referenceFor(order.id, item.sku);

    const lookup = await game.getTopup(reference);
    if (lookup.state === 'found') {
      if (lookup.count > 1) logger.error(`reference ${reference} shows ${lookup.count} top-ups`);
      await markDelivered(pool, order.id, reference);
      delivered += 1;
      continue;
    }
    if (lookup.state === 'unknown') {
      await retryLater(lookup.reason, true);
      return;
    }

    if (lastClaim || (await countPosts(pool, job, reference)) >= config.maxPosts) {
      notDelivered += 1;
      continue;
    }

    const started = performance.now();
    const attemptId = await beginAttempt(pool, job, reference, config.leaseMs);
    if (attemptId === undefined) return; // Another worker owns this job now.
    // If this process stalled for longer than the lease allows, the job may be someone else's.
    if (performance.now() - started > config.leaseMs - config.postTimeoutMs - config.settleMs) {
      await finishAttempt(pool, attemptId, 'FAILED', null, 'stalled, POST was not sent');
      return;
    }

    const result = await game.postTopup({
      reference,
      game_uid: order.game_uid,
      sku: item.sku,
      qty: item.qty,
    });
    if (result.state === 'ok') {
      await finishAttempt(pool, attemptId, 'SUCCEEDED', result.httpStatus, null);
      delivered += 1;
    } else if (result.state === 'rejected') {
      // The provider refused this request and will refuse the same bytes again.
      await finishAttempt(pool, attemptId, 'FAILED', result.httpStatus, 'rejected');
      notDelivered += 1;
    } else if (result.state === 'failed') {
      await finishAttempt(pool, attemptId, 'FAILED', result.httpStatus, 'provider error');
      await retryLater(`POST answered ${result.httpStatus}`, false);
      return;
    } else {
      await finishAttempt(pool, attemptId, 'UNKNOWN', null, result.reason);
      await retryLater(result.reason, true);
      return;
    }
  }

  if (notDelivered === 0) {
    await completeFulfillment(pool, job);
  } else if (delivered > 0) {
    // Part of the order reached the player, so a full automatic refund would be wrong.
    await sendFulfillmentToReview(pool, job, `${delivered} lines delivered, ${notDelivered} not`);
  } else {
    await failFulfillment(pool, job, 'top-up confirmed not delivered after retries');
  }
}

/** The refund row was committed before this job existed, so a crash here only causes a resend. */
export async function runRefund(deps: HandlerDeps, job: Job): Promise<void> {
  const { pool, pay, config } = deps;
  const refund = await loadRefund(pool, String(job.payload.refund_id));
  if (!refund || refund.status !== 'PENDING') {
    await closeOnly(pool, job, 'refund is not pending');
    return;
  }

  const result = await pay.postRefund(
    refund.refund_ref,
    refund.order_id,
    toSatang(refund.amount_satang),
  );
  if (result.state === 'ok') {
    const outcome = await settleRefund(pool, job, refund, result.eventId);
    if (outcome === 'unmatched') logger.error(`refund ${refund.id} had no pending row to settle`);
  } else if (result.state === 'rejected') {
    await rejectRefund(pool, job, refund, `provider refused the refund: ${result.code}`);
  } else if (job.attempts >= config.refundMaxAttempts) {
    await giveUpOnRefund(pool, job, refund, `refund unconfirmed: ${result.reason}`);
  } else {
    await reschedule(
      pool,
      job,
      backoffMs(job.attempts, config.refundBackoffBaseMs, config.backoffCapMs),
      result.reason,
    );
  }
}

<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">framework ของ <a href="http://nodejs.org" target="_blank">Node.js</a> สำหรับสร้างแอปฝั่ง server ที่มีประสิทธิภาพและขยายได้</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## คำอธิบาย

repository ตั้งต้นของ framework [Nest](https://github.com/nestjs/nest) สำหรับ TypeScript

## ติดตั้งโปรเจกต์

```bash
$ npm install
```

## Compile และรันโปรเจกต์

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## รัน test

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

เมื่อพร้อม deploy แอป NestJS ขึ้น production มีขั้นตอนสำคัญบางอย่างที่ช่วยให้รันได้อย่างมีประสิทธิภาพที่สุด ดูข้อมูลเพิ่มเติมที่ [เอกสารการ deploy](https://docs.nestjs.com/deployment)

ถ้าต้องการแพลตฟอร์มบน cloud สำหรับ deploy แอป NestJS ดู [Mau](https://mau.nestjs.com) แพลตฟอร์มทางการสำหรับ deploy แอป NestJS บน AWS Mau ทำให้การ deploy ง่ายและเร็ว ใช้เพียงไม่กี่ขั้นตอน:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

ด้วย Mau คุณ deploy แอปได้ในไม่กี่คลิก และโฟกัสกับการสร้างฟีเจอร์แทนการดูแล infrastructure

## Observability

ในแอป production นั้น observability จำเป็นต่อการเข้าใจพฤติกรรมของระบบ ตรวจพบปัญหาแต่เนิ่น ๆ และรักษาประสิทธิภาพให้เชื่อถือได้

[NestJS Observe](https://observe.nestjs.com) instrument แอป NestJS ให้อัตโนมัติ ทำให้มองเห็นระบบได้ลึกโดยตั้งค่าน้อยที่สุด:

- **Distributed tracing:** ติดตาม request ข้าม service และเข้าใจว่าไหลผ่านระบบอย่างไร
- **Waterfall analysis:** แสดงภาพการทำงานของ request และหาจุดที่ช้า คอขวด และความล่าช้าที่ไม่คาดคิด
- **Performance analysis:** วิเคราะห์ประสิทธิภาพแบบ real time และชี้จุดที่ต้อง optimize ได้เร็ว
- **Metrics:** ติดตาม metric สำคัญของแอปและ infrastructure เพื่อเข้าใจสุขภาพระบบและแนวโน้มประสิทธิภาพ
- **Logging:** รวม log ไว้ที่เดียวและเชื่อมกับ trace และ telemetry อื่นเพื่อให้ debug ง่ายขึ้น
- **Error tracking:** ตรวจพบ error ได้เร็วและสืบหาต้นเหตุพร้อมบริบทรอบข้าง
- **SLA monitoring:** ติดตาม service-level objective และรู้เมื่อแอปเข้าใกล้หรือเกินเกณฑ์ที่กำหนด
- **Alarms and alerts:** ตั้ง alert สำหรับ error ร้ายแรง ประสิทธิภาพตก การละเมิด SLA และความผิดปกติอื่น เพื่อให้ทีมตอบสนองได้เร็ว

หากต้องการเพิ่มเข้าโปรเจกต์นี้ ให้รันคำสั่งนี้แล้วอนุมัติรหัสที่แสดงที่ [observe.nestjs.com/link](https://observe.nestjs.com/link) - สมัครฟรีได้ถ้ายังไม่มีบัญชี:

```bash
$ npx @nestjs/observe link
```

คำสั่งนี้ติดตั้ง `@nestjs/observe` ต่อเข้ากับ `AppModule` และ `main.ts` และเขียน app key กับ secret ลง `.env` ซึ่งทุกสคริปต์ `nest start` (`start`, `start:dev`, `start:debug`) จะโหลด ใน production ให้ตั้ง `OBSERVE_APP_KEY` และ `OBSERVE_APP_SECRET` ใน environment แทน

หรือทำเอง:

```bash
$ npm install @nestjs/observe
```

แล้วทำตาม [คู่มือการตั้งค่า](https://docs.nestjs.com/observability/sdk) - ใช้แค่ import เดียวและ app key

แผนฟรีไม่ต้องใช้ข้อมูลการชำระเงิน และครอบคลุม 300,000 events ต่อเดือน ดู [live demo](https://www.observe-demo.nestjs.com/dashboard) ก่อนได้ - เป็น dashboard เต็มบนข้อมูลของ service ที่มีงานเยอะ โดยไม่ต้องติดตั้งอะไร

## แหล่งข้อมูล

แหล่งข้อมูลที่อาจเป็นประโยชน์เมื่อทำงานกับ NestJS:

- เข้า [NestJS Documentation](https://docs.nestjs.com) เพื่อเรียนรู้ framework เพิ่มเติม
- สำหรับคำถามและการช่วยเหลือ เข้า [Discord channel](https://discord.gg/G7Qnnhy)
- หากต้องการเจาะลึกและลงมือมากขึ้น ดู [คอร์ส](https://courses.nestjs.com/) วิดีโอทางการ
- Deploy แอปขึ้น AWS ได้ในไม่กี่คลิกด้วย [NestJS Mau](https://mau.nestjs.com)
- Instrument แอปอัตโนมัติด้วย [NestJS Observe](https://observe.nestjs.com) ทำ distributed tracing, metrics และ logging ได้ง่าย พร้อม error tracking และ performance monitoring สำหรับแอป NestJS
- แสดงภาพ application graph และโต้ตอบกับแอป NestJS แบบ real-time ด้วย [NestJS Devtools](https://devtools.nestjs.com)
- ต้องการความช่วยเหลือในโปรเจกต์ (part-time ถึง full-time)? ดู [enterprise support](https://enterprise.nestjs.com) ทางการ
- ติดตามข่าวสารได้ที่ [X](https://x.com/nestframework) และ [LinkedIn](https://linkedin.com/company/nestjs)
- กำลังหางานหรือมีงานจะเสนอ? ดู [Jobs board](https://jobs.nestjs.com) ทางการ

## Support

Nest เป็นโปรเจกต์ open source สัญญาอนุญาต MIT เติบโตได้ด้วยผู้สนับสนุนและ backer ถ้าต้องการร่วมสนับสนุน [อ่านเพิ่มเติมที่นี่](https://docs.nestjs.com/support)

## ติดต่อ

- ผู้เขียน - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- เว็บไซต์ - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest ใช้ [สัญญาอนุญาต MIT](https://github.com/nestjs/nest/blob/master/LICENSE)

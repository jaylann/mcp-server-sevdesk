# Changelog

## [1.7.0](https://github.com/jaylann/mcp-server-sevdesk/compare/v1.6.0...v1.7.0) (2026-11-20)


### Features

* **approvals:** keep traces of ended requests and announce every change ([#98](https://github.com/jaylann/mcp-server-sevdesk/issues/98)) ([277f342](https://github.com/jaylann/mcp-server-sevdesk/commit/277f342fc75a0f762f9fd7adecb1b1a522c0a357))
* **banking:** create file-import and clearing accounts ([#109](https://github.com/jaylann/mcp-server-sevdesk/issues/109)) ([7a34dd5](https://github.com/jaylann/mcp-server-sevdesk/commit/7a34dd5831bf01106edb0c7c9645ba68f1fb342e))
* **banking:** enter, delete and enshrine bank transactions by hand ([#118](https://github.com/jaylann/mcp-server-sevdesk/issues/118)) ([e88f696](https://github.com/jaylann/mcp-server-sevdesk/commit/e88f6963c84efa1a61843018029ceeea56d25e85))
* **banking:** list, create and delete private-transaction rules ([#122](https://github.com/jaylann/mcp-server-sevdesk/issues/122)) ([41a87bf](https://github.com/jaylann/mcp-server-sevdesk/commit/41a87bfb9aa76ae5a317594e5b5c8bf07761cb85))
* **banking:** rename, change and archive payment accounts ([#141](https://github.com/jaylann/mcp-server-sevdesk/issues/141)) ([4013452](https://github.com/jaylann/mcp-server-sevdesk/commit/4013452a45e4b453f112324759bfb4582af886b9))
* **client:** cap JSON answers at 16 MiB while streaming ([#139](https://github.com/jaylann/mcp-server-sevdesk/issues/139)) ([63b5f24](https://github.com/jaylann/mcp-server-sevdesk/commit/63b5f2402f6be29b6b07dc563d6e2733d76f47c2))
* **contacts:** link persons to organisations, remove details and delete contacts ([#108](https://github.com/jaylann/mcp-server-sevdesk/issues/108)) ([380cce4](https://github.com/jaylann/mcp-server-sevdesk/commit/380cce47b529c441fbed77803b62b2143f1c2ed9))
* **contacts:** read, set, remove and search custom contact fields ([#116](https://github.com/jaylann/mcp-server-sevdesk/issues/116)) ([ab840a5](https://github.com/jaylann/mcp-server-sevdesk/commit/ab840a5ff629eb554cdab6a4a13c88c0cbd1252d))
* **cost-centres:** book, filter and show cost centres on documents ([#113](https://github.com/jaylann/mcp-server-sevdesk/issues/113)) ([566d3d5](https://github.com/jaylann/mcp-server-sevdesk/commit/566d3d51fcdaee82216d07c32f06c626edd822a9))
* **credit-notes:** update credit-note drafts ([#107](https://github.com/jaylann/mcp-server-sevdesk/issues/107)) ([67c20c3](https://github.com/jaylann/mcp-server-sevdesk/commit/67c20c344a14261fcbd3429105af036b5b2adca0))
* **documents:** add a discount on the whole document to drafts ([#114](https://github.com/jaylann/mcp-server-sevdesk/issues/114)) ([6f1deb4](https://github.com/jaylann/mcp-server-sevdesk/commit/6f1deb496c076f57f501b80f5f215b0c1bc73803))
* **documents:** set language, template and letterhead of drafts ([#123](https://github.com/jaylann/mcp-server-sevdesk/issues/123)) ([666123e](https://github.com/jaylann/mcp-server-sevdesk/commit/666123e720cd662856da283d6fc2dadb6296ab46))
* **drafts:** compute discount totals over several tax rates ([#161](https://github.com/jaylann/mcp-server-sevdesk/issues/161)) ([3c70ed9](https://github.com/jaylann/mcp-server-sevdesk/commit/3c70ed99cd381d91508cafd34287e5a9e8b7c905))
* **drafts:** delete invoice, order and credit-note drafts ([#106](https://github.com/jaylann/mcp-server-sevdesk/issues/106)) ([2965fb1](https://github.com/jaylann/mcp-server-sevdesk/commit/2965fb1ad63d7b6fe2845b5bfffce520afe940af))
* **exports:** add document archives, DATEV XML and DATEV settings ([#111](https://github.com/jaylann/mcp-server-sevdesk/issues/111)) ([6b74fd3](https://github.com/jaylann/mcp-server-sevdesk/commit/6b74fd3fc8620d827e3ecd1e642aedfb453b4a16))
* **invoices:** change, end and reactivate recurring invoice templates ([#124](https://github.com/jaylann/mcp-server-sevdesk/issues/124)) ([62c94b5](https://github.com/jaylann/mcp-server-sevdesk/commit/62c94b5184f2aed1eccd14abf59b8b0e0001724e))
* **invoices:** create recurring invoice templates (abo-rechnungen) ([#121](https://github.com/jaylann/mcp-server-sevdesk/issues/121)) ([52c1c20](https://github.com/jaylann/mcp-server-sevdesk/commit/52c1c2066f6fb406b1fac5902d970cd13db9b2e1))
* **invoices:** show the tax-rule hint in German and on recurring templates ([#142](https://github.com/jaylann/mcp-server-sevdesk/issues/142)) ([4fda964](https://github.com/jaylann/mcp-server-sevdesk/commit/4fda964ceacf576224b3b09ddc1f43da3217476d))
* **orders:** accept or reject offers, create confirmations and delivery notes ([#112](https://github.com/jaylann/mcp-server-sevdesk/issues/112)) ([6f1ac87](https://github.com/jaylann/mcp-server-sevdesk/commit/6f1ac877c50b4f40a47c25616096e1c15dfde367))
* **orders:** advance the number counter for order confirmations and delivery notes ([#150](https://github.com/jaylann/mcp-server-sevdesk/issues/150)) ([9cb97b7](https://github.com/jaylann/mcp-server-sevdesk/commit/9cb97b7e14e58e1c662adbe2cbac0147b590942e))
* **pages:** build the server pages on the lanfermann design system ([#167](https://github.com/jaylann/mcp-server-sevdesk/issues/167)) ([95ec043](https://github.com/jaylann/mcp-server-sevdesk/commit/95ec043e1e12e9062695a0dc6b019addf84b64b0))
* **prompts:** add prompts for missing receipts, year-end handoff and offer follow-up ([#126](https://github.com/jaylann/mcp-server-sevdesk/issues/126)) ([4202983](https://github.com/jaylann/mcp-server-sevdesk/commit/4202983d3468898af39802786ad9e6ea29524011))
* **prompts:** complete prompt arguments and declare server icons ([#102](https://github.com/jaylann/mcp-server-sevdesk/issues/102)) ([f757231](https://github.com/jaylann/mcp-server-sevdesk/commit/f75723128d86814c75acfa94081086bd9a653f41))
* replace the stamp mark with the new sigma mark ([#83](https://github.com/jaylann/mcp-server-sevdesk/issues/83)) ([4827218](https://github.com/jaylann/mcp-server-sevdesk/commit/48272182140a4f8f4fec283e42e5df059a558f34))
* **reports:** add a receipt folder check and audit steps in prompts ([#120](https://github.com/jaylann/mcp-server-sevdesk/issues/120)) ([46483e4](https://github.com/jaylann/mcp-server-sevdesk/commit/46483e4bc8a89398c1fa5747b8a7e526bd0ca133))
* **reports:** add a tax-rule helper for sales and a VAT-ID check ([#100](https://github.com/jaylann/mcp-server-sevdesk/issues/100)) ([0a12771](https://github.com/jaylann/mcp-server-sevdesk/commit/0a12771e35022ef98197bd0798d39b3ac9bb452e))
* **reports:** add an account audit tool with vat treatment and reverse-charge checks ([#103](https://github.com/jaylann/mcp-server-sevdesk/issues/103)) ([0bd6056](https://github.com/jaylann/mcp-server-sevdesk/commit/0bd60567255918814d2df3498850f6799f020f20))
* **reports:** add duplicate and recurring-gap checks to the audit ([#115](https://github.com/jaylann/mcp-server-sevdesk/issues/115)) ([dc967a8](https://github.com/jaylann/mcp-server-sevdesk/commit/dc967a80c975fd943179605438a6343a7b82dd3f))
* **reports:** filter and group the reports by tag and cost centre ([#119](https://github.com/jaylann/mcp-server-sevdesk/issues/119)) ([1bfedba](https://github.com/jaylann/mcp-server-sevdesk/commit/1bfedbae161c052710ba1c57b884e76155673cb7))
* **tags:** list tags, tag documents and filter lists by tag ([#105](https://github.com/jaylann/mcp-server-sevdesk/issues/105)) ([0d56c3d](https://github.com/jaylann/mcp-server-sevdesk/commit/0d56c3d245e849823d8de1beb3f121239c5721fb))
* **vouchers:** accept receipt files from an https url ([#101](https://github.com/jaylann/mcp-server-sevdesk/issues/101)) ([92405b5](https://github.com/jaylann/mcp-server-sevdesk/commit/92405b57500ec2ba347ea4e05efe22b52270689f))
* **vouchers:** check a receipt's sha-256 before recognition ([#138](https://github.com/jaylann/mcp-server-sevdesk/issues/138)) ([c9dc7ae](https://github.com/jaylann/mcp-server-sevdesk/commit/c9dc7ae58e8b785492a1b8fceafcff63eb018a00))
* **vouchers:** draft vouchers from sevDesk's receipt recognition ([#117](https://github.com/jaylann/mcp-server-sevdesk/issues/117)) ([73c6dba](https://github.com/jaylann/mcp-server-sevdesk/commit/73c6dba4bf97668d3b0d612ac37e4de067e2a38d))


### Bug Fixes

* **banking:** search private-transaction rules past page 1, hedge texts ([#143](https://github.com/jaylann/mcp-server-sevdesk/issues/143)) ([f24faad](https://github.com/jaylann/mcp-server-sevdesk/commit/f24faada853a92e4cc261ad69e43139565c17474))
* **client:** require commit tier for private-transaction-rule writes ([#140](https://github.com/jaylann/mcp-server-sevdesk/issues/140)) ([71ca3ac](https://github.com/jaylann/mcp-server-sevdesk/commit/71ca3ac5558c7789ea9984352cf13274ef4c403a))
* close data-loss and unsafe-write gaps from the 2026-11-20 review ([#168](https://github.com/jaylann/mcp-server-sevdesk/issues/168)) ([61f0a45](https://github.com/jaylann/mcp-server-sevdesk/commit/61f0a451f72464b383fba98a86f1204cb7b0dede))
* **contacts:** call custom contact fields Kontaktfelder, as sevDesk does ([#148](https://github.com/jaylann/mcp-server-sevdesk/issues/148)) ([6e7c108](https://github.com/jaylann/mcp-server-sevdesk/commit/6e7c108ff978f9212be87ea84959c68328d012ee))
* **deps:** bump distroless/nodejs24-debian13 from `088a016` to `6abfcb3` in the docker-images group ([#78](https://github.com/jaylann/mcp-server-sevdesk/issues/78)) ([32c0d4e](https://github.com/jaylann/mcp-server-sevdesk/commit/32c0d4ea38bf7a9fb486a0c0e0fc0644ad1089c5))
* **drafts:** stop quoting sevDesk document numbers in warnings and notes ([#153](https://github.com/jaylann/mcp-server-sevdesk/issues/153)) ([6d3fddc](https://github.com/jaylann/mcp-server-sevdesk/commit/6d3fddc21f8a777a55ad62a95176cfa11ff37d5a))
* **paging:** keep rows once and flag lists read past one page ([#164](https://github.com/jaylann/mcp-server-sevdesk/issues/164)) ([63215c5](https://github.com/jaylann/mcp-server-sevdesk/commit/63215c53c9435c0b9e99cf31436eac0bcc3227ab))
* **previews:** name accounts and tags by kind and id in action lines ([#149](https://github.com/jaylann/mcp-server-sevdesk/issues/149)) ([10c8e1f](https://github.com/jaylann/mcp-server-sevdesk/commit/10c8e1fd03755e6539d1f2919d5560f8c712ca83))
* **previews:** name documents by kind and id in action lines ([#144](https://github.com/jaylann/mcp-server-sevdesk/issues/144)) ([ca45221](https://github.com/jaylann/mcp-server-sevdesk/commit/ca4522126892fb77b2acb550f6d26cd06c90a63e))
* record the 2026-11-18 trial answers and drop the hedges they settle ([#157](https://github.com/jaylann/mcp-server-sevdesk/issues/157)) ([b660196](https://github.com/jaylann/mcp-server-sevdesk/commit/b6601964dea4821ff613a76397a3948d5c69a21c))
* record trial answers for discount rounding and address paging ([#166](https://github.com/jaylann/mcp-server-sevdesk/issues/166)) ([acc2810](https://github.com/jaylann/mcp-server-sevdesk/commit/acc2810d9ff1227e03d56f09fe4ee14be81e01d1))
* **reports:** read document lists in date windows of one page each ([#160](https://github.com/jaylann/mcp-server-sevdesk/issues/160)) ([f20123e](https://github.com/jaylann/mcp-server-sevdesk/commit/f20123e05657cbbafad2b469bc09b5355abd343f))


### Performance

* **prompts:** answer longer typed contact names from a complete search ([#159](https://github.com/jaylann/mcp-server-sevdesk/issues/159)) ([1f74d33](https://github.com/jaylann/mcp-server-sevdesk/commit/1f74d33f566dd6af2506debd3337d410aac4cfbd))

## [1.6.0](https://github.com/jaylann/mcp-server-sevdesk/compare/v1.5.0...v1.6.0) (2026-11-16)


### Features

* **de:** address the reader as du in the German docs and pages ([#74](https://github.com/jaylann/mcp-server-sevdesk/issues/74)) ([f8890af](https://github.com/jaylann/mcp-server-sevdesk/commit/f8890afb69fc0a2e5d59158d2a83a8364c335778))

## [1.5.0](https://github.com/jaylann/mcp-server-sevdesk/compare/v1.4.0...v1.5.0) (2026-11-13)


### Features

* **vouchers:** create and update foreign-currency voucher drafts ([#59](https://github.com/jaylann/mcp-server-sevdesk/issues/59)) ([4a671ec](https://github.com/jaylann/mcp-server-sevdesk/commit/4a671ecb94a5142366870f6aec02c540f14e0dcf))


### Performance

* **lifecycle:** load the country table once per tool call instead of on every document read ([#58](https://github.com/jaylann/mcp-server-sevdesk/issues/58)) ([3a9b788](https://github.com/jaylann/mcp-server-sevdesk/commit/3a9b78810453593a8a5f57e4bf574d45ef6b967c))
* **lists:** add a summary detail level to the list tools ([#69](https://github.com/jaylann/mcp-server-sevdesk/issues/69)) ([f061020](https://github.com/jaylann/mcp-server-sevdesk/commit/f0610208f6d3d6bb20b95c392e27e8c4eee04c01))
* **output:** return minified json in tool results ([#64](https://github.com/jaylann/mcp-server-sevdesk/issues/64)) ([dd9e9b7](https://github.com/jaylann/mcp-server-sevdesk/commit/dd9e9b70de2d97b4e0d145921c387d1b12561124))
* **schemas:** slim the output schemas in tools/list ([#60](https://github.com/jaylann/mcp-server-sevdesk/issues/60)) ([e738115](https://github.com/jaylann/mcp-server-sevdesk/commit/e738115818ce724d1827642bc12650748a99d963))

## [1.4.0](https://github.com/jaylann/mcp-server-sevdesk/compare/v1.3.0...v1.4.0) (2026-11-13)


### Features

* add filter keys, iso country codes and lookup paging to outputs ([#43](https://github.com/jaylann/mcp-server-sevdesk/issues/43)) ([5d25fc3](https://github.com/jaylann/mcp-server-sevdesk/commit/5d25fc34744a4f266518c2c3a99e06ceb6995911))
* **files:** free upload slots after use and make the per-account limit configurable ([#37](https://github.com/jaylann/mcp-server-sevdesk/issues/37)) ([ad1c63d](https://github.com/jaylann/mcp-server-sevdesk/commit/ad1c63d7c29d06ed200956c3870cf199ad125f78))
* **keychain:** read the token from the windows credential manager ([#46](https://github.com/jaylann/mcp-server-sevdesk/issues/46)) ([6734d65](https://github.com/jaylann/mcp-server-sevdesk/commit/6734d651299ce35e4933cc9e6ea70713c794bdc4))
* **mcpb:** offer the audit log setting and list the bundle in server.json ([#47](https://github.com/jaylann/mcp-server-sevdesk/issues/47)) ([77f4904](https://github.com/jaylann/mcp-server-sevdesk/commit/77f49047d1145bea87f02f2da7e7937ab703a7ac))
* **meta:** upload several files through one upload request ([#42](https://github.com/jaylann/mcp-server-sevdesk/issues/42)) ([4a407b1](https://github.com/jaylann/mcp-server-sevdesk/commit/4a407b1854f5c8e6402e8e57a148d0e886162210))
* **prompts:** add optional scoping arguments to dunning_run and bank_reconciliation ([#44](https://github.com/jaylann/mcp-server-sevdesk/issues/44)) ([42e7b4d](https://github.com/jaylann/mcp-server-sevdesk/commit/42e7b4d9c6bccb285d19f277362e6d96fcfe6afe))
* **vouchers:** convert foreign-currency voucher drafts to eur ([#45](https://github.com/jaylann/mcp-server-sevdesk/issues/45)) ([d32f65e](https://github.com/jaylann/mcp-server-sevdesk/commit/d32f65efe6756b99066d6e00959f486e89e6816e))


### Bug Fixes

* **security:** close the code-scanning alerts code can fix ([#38](https://github.com/jaylann/mcp-server-sevdesk/issues/38)) ([49bb50d](https://github.com/jaylann/mcp-server-sevdesk/commit/49bb50d5fa74427239d60dc93bf5dd4636363fc1))

## [1.3.0](https://github.com/jaylann/mcp-server-sevdesk/compare/v1.2.0...v1.3.0) (2026-11-11)


### Bug Fixes

* close the findings of the 2026-11 security and code review ([#31](https://github.com/jaylann/mcp-server-sevdesk/issues/31)) ([64d9120](https://github.com/jaylann/mcp-server-sevdesk/commit/64d91207725365cef1bcf93390502435320070e0))
* **security:** close the findings of the 2026-11 security review ([#29](https://github.com/jaylann/mcp-server-sevdesk/issues/29)) ([63a4080](https://github.com/jaylann/mcp-server-sevdesk/commit/63a4080842446c1f6db116e06d5895151c9819aa))


### Miscellaneous

* release 1.3.0 ([#32](https://github.com/jaylann/mcp-server-sevdesk/issues/32)) ([a5d3443](https://github.com/jaylann/mcp-server-sevdesk/commit/a5d34430ef0187d219baccb733e6973d7de9e788))

## [1.2.0](https://github.com/jaylann/mcp-server-sevdesk/compare/v1.1.0...v1.2.0) (2026-11-11)


### Features

* **pages:** redesign the server's pages, with German pages and previews ([#27](https://github.com/jaylann/mcp-server-sevdesk/issues/27)) ([1f5df98](https://github.com/jaylann/mcp-server-sevdesk/commit/1f5df98301fb74bed1f55e5fea2a1e664715d7a5))

## [1.1.0](https://github.com/jaylann/mcp-server-sevdesk/compare/v1.0.0...v1.1.0) (2026-11-10)


### Features

* **vouchers:** save the receipt file attached to a voucher ([#25](https://github.com/jaylann/mcp-server-sevdesk/issues/25)) ([239f28f](https://github.com/jaylann/mcp-server-sevdesk/commit/239f28f908078ae47b6b76d67c2415801ba1853c))

## [1.0.0](https://github.com/jaylann/mcp-server-sevdesk/compare/v0.1.0...v1.0.0) (2026-11-10)


### Features

* add file transfer, profiles, prompts and api_get for 1.0 ([#18](https://github.com/jaylann/mcp-server-sevdesk/issues/18)) ([eaf81b9](https://github.com/jaylann/mcp-server-sevdesk/commit/eaf81b9397d16f2664b28fd8038ec501ff6c6311))


### Bug Fixes

* link the docs site at sevdeskmcp.lanfermann.dev ([#20](https://github.com/jaylann/mcp-server-sevdesk/issues/20)) ([17f6492](https://github.com/jaylann/mcp-server-sevdesk/commit/17f64929738de3c1fd660ae4885d1b897fecf2b1))

## 0.1.0 (2026-11-10)


### Features

* add all read tools, document resources and reports ([#3](https://github.com/jaylann/mcp-server-sevdesk/issues/3)) ([419cf2d](https://github.com/jaylann/mcp-server-sevdesk/commit/419cf2d8f6bc9b04f2dc98c36dae7a81581ae173))
* add receipt, e-invoice, reconciliation and tax report tools ([#6](https://github.com/jaylann/mcp-server-sevdesk/issues/6)) ([6c22b50](https://github.com/jaylann/mcp-server-sevdesk/commit/6c22b50d12150260938a3bf7f2386d171c7dd04d))
* add remote mode with oauth, a docker image and deploy templates ([#8](https://github.com/jaylann/mcp-server-sevdesk/issues/8)) ([f3d6ae3](https://github.com/jaylann/mcp-server-sevdesk/commit/f3d6ae3b28ec8a214aa3927f28a386e81cb25033))
* add sevdesk client, tool framework and read-only tools ([63d291d](https://github.com/jaylann/mcp-server-sevdesk/commit/63d291decfceaaa2e6f49793262ecffcb6f67288))
* add write tools with human confirmation and an audit log ([#4](https://github.com/jaylann/mcp-server-sevdesk/issues/4)) ([3c3ca94](https://github.com/jaylann/mcp-server-sevdesk/commit/3c3ca949c1f2141964614a4188d3fde97d496c43))


### Bug Fixes

* align write tools with the recorded sevdesk behavior ([#5](https://github.com/jaylann/mcp-server-sevdesk/issues/5)) ([9634b65](https://github.com/jaylann/mcp-server-sevdesk/commit/9634b6512e5112953db1d536c5c56cb46f1f56e7))

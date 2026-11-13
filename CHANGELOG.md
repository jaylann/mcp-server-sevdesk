# Changelog

## Unreleased

### Performance Improvements

* **output:** return minified JSON in tool result text and reference resources; summaries, JSON values and `structuredContent` are unchanged ([#62](https://github.com/jaylann/mcp-server-sevdesk/issues/62)).

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

# PERSEO F2 — Complete suite evidence

Date: 2026-07-28  
Command: `npm run test:all-offline`  
Commit under test before certification-harness commit: `96bf15b885e94d394782665c738c99234e10e0cb`

The runner enumerates every `*.test.js` file below `test/` and `conversation/`.
Each file runs in a fresh Node process with production credentials removed,
safe invalid credentials injected, external network blocked, loopback allowed
for local API tests, and the sibling ATENA dependency resolved from the Git
common directory.

Result:

- files enumerated: 176;
- green files: 160;
- red files: 16;
- timed-out files: 0;
- complete repetitions requested: 1;
- complete repetitions passed: 0.

Red files:

1. `test/argosConversationFlexibilitySuite.test.js`
2. `test/argosM2PolicyCross.test.js`
3. `test/argosM401Suites.test.js`
4. `test/argosM402Suites.test.js`
5. `test/argosM403Suites.test.js`
6. `test/argosReleaseP1Suite.test.js`
7. `test/closureIntegrity.test.js`
8. `test/conversationFlexibilityQuickWins.test.js`
9. `test/cuarzoP0Regression.test.js`
10. `test/m4RuntimeStabilization.test.js`
11. `test/mediaIngestion.test.js`
12. `test/namePrompt.test.js`
13. `test/sprint0cBlindaje.test.js`
14. `test/v3F31Handoff.test.js`
15. `test/v3F32CampaignIntake.test.js`
16. `test/v3F4ComposerObjections.test.js`

Examples of unresolved product assertions include:

- FLEX_017 and FLEX_020 misclassify sale, zone and name fields.
- Legacy policy/cross-intent suites remain below their required threshold.
- Handoff and post-handoff response contracts disagree with current copy.
- Media failure classification returns metadata failure where the contract
  expects download failure.
- Full-name parsing and campaign identity prompts regress.
- Replay pack determinism is false.

No test was omitted and no pass threshold was weakened.


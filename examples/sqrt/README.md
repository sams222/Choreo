# Integer square root (Phase D demo)

This tree is a **different job** from `fixture/` (`parseIndex`). LoopSync copies it into an isolated workspace, locks `sqrt.test.js`, and runs `node --test`.

`integerSqrt` currently returns `0`. The test expects `integerSqrt(9) === 3`. There is no `parse.js` here — a successful SHA must contain `sqrt.js`, not the homework parser.

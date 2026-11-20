/**
 * Rung 2 of the ladder: the one-day observe run. v1 of this tool hands the
 * agent the PLAN — what the day is, what it answers, and the two honesty
 * requirements any implementation must carry (both came out of cold-read
 * testing with simulated skeptical founders). The concrete wiring involves
 * consent about where rows land, so it ends in a human decision by design.
 */
// Amendment A5: the plain words first, and none of our words for what it measures (until fix pass 1: "# The one-day observe
// run", "walkaway failures that green health checks miss", "kgauto's judged eval")
export const OBSERVE_DAY_PLAN = `# One day of recorded calls — the observe day (for you, the agent — decision stays with your human)

## What it is
One day of your project's normal traffic, recorded. No routing changes: every call still goes to exactly the model your code chooses today. The observation records, per call: model, token counts in/out, cost at verified prices, latency, success/failure with a classified error code, and per-attempt rows when retries happen. Identifiers and counts — prompt text is never required.

## What it answers (the measurable-only tier of your check card)
- how often each model's calls fail — including the failures that still look like a normal answer, which a health check passes
- actual input-waste ratio per call site (the >85% input-share signal, measured instead of estimated)
- which call sites dominate spend
- the evidence for whether a cheaper model could do this work as well (its answers graded on your real recorded cases, never judged on price alone)

## The two honesty requirements (non-negotiable, relay both)
1. **Destination, named before anything runs.** Your human gets one plain sentence stating exactly where outcome rows land and what is in them, BEFORE the first row is written. "Nothing is uploaded" was true of the check because it writes nothing; the observe day writes rows, so it must say where.
2. **Observation never intervenes.** If your project uses fallback chains, observing must not pin a model and silently disable the chain — a forced pin is an intervention sold as observation. Rows are recorded per attempt, so the chain's real behaviour is what gets measured.

## How to proceed
The integration is small (the kgauto compiler's call/record path with your existing keys), but because rows now land somewhere, the wiring starts with that destination sentence and your human's explicit yes. Next step: have your human reply to whoever pointed them at kgauto — the observe day is set up per-project, together.`;

#!/usr/bin/env python3
"""Re-derive every number in docs/reviews/2026-11-12-the-check-on-40-public-projects.md from
public-records.json beside this file. No network, no other input.

    python3 docs/reviews/tally_public.py

The bars, each fixed before the result it judges:
R4 (run one, the first 20): viable if >= 10 of 20 have one or more true actionable findings; 5-9 weak; under 5 fails.
R6 (run two, the same 20): viable if >= 14 of 20 have one or more true actionable findings AND no more
   than 1 line is false (restated by Amendment C: a finding at certain or likely, verified on the
   provider's page; a false line at any tier counts).
A2 (the second 20): no bar; >= 10 of 20 holding a flagged id = "not a beginner's pain alone",
   < 5 = "mostly a beginner's", between = unclear.
"""
import json
import os
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
TIERS = ["certain", "likely", "measurable-only"]
VERDICTS = ["true", "false", "not checkable"]
GROUPS = ["team-run", "seasoned individual", "newer individual"]
BANDS = ["under 1,000", "1,000\u20139,999", "10,000 or more"]


R4_BAR = 10


def load_doc():
    with open(os.path.join(HERE, "public-records.json"), encoding="utf-8") as fh:
        return json.load(fh)


def load():
    return load_doc()["projects"]


def lines(run, pred=lambda l: True):
    return sum(l["count"] for l in run["lines"] if pred(l))


def ta(run):
    return lines(run, lambda l: l["actionable"] and l["verdict"] == "true")


def rows_with(projects, run):
    return [(p, p["runs"][run]) for p in projects if p["runs"].get(run)]


def tier_table(runs):
    by = Counter()
    for r in runs:
        for l in r["lines"]:
            by[(l["tier"], l["verdict"])] += l["count"]
    print(f"{'tier':<16}{'total':>6}" + "".join(f"{v:>15}" for v in VERDICTS))
    for t in TIERS:
        tot = sum(by[(t, v)] for v in VERDICTS)
        print(f"{t:<16}{tot:>6}" + "".join(f"{by[(t, v)]:>15}" for v in VERDICTS))
    allv = {v: sum(by[(t, v)] for t in TIERS) for v in VERDICTS}
    print(f"{'all':<16}{sum(allv.values()):>6}" + "".join(f"{allv[v]:>15}" for v in VERDICTS))


def kinds(runs):
    c = Counter()
    for r in runs:
        for l in r["lines"]:
            c[l["kind"]] += l["count"]
    print("\n== Findings by kind ==")
    for kind, n in sorted(c.items(), key=lambda x: (-x[1], x[0])):
        print(f"  {kind:<26}{n}")


def run_one(projects):
    rs = rows_with(projects, "run1")
    runs = [r for _, r in rs]
    k = sum(1 for r in runs if ta(r) > 0)
    verdict = "viable" if k >= R4_BAR else ("weak" if k >= 5 else "fails")
    print("== Headline (R4) ==")
    print(f"projects run                                   {len(rs)}")
    print(f"projects with a card                           {sum(1 for r in runs if r['card'])}")
    print(f"projects with >=1 true actionable finding      {k}")
    print(f"R4 verdict                                     {verdict}  (viable >=10, weak 5-9, fails <5)")
    lenient = sum(1 for r in runs if ta(r) > 0 or r["direction_agrees"] > 0)
    print(f"  context, not the rule: counting false-but-direction-agrees alias findings too   {lenient}")
    print(f"  context, not the rule: projects whose extract holds an id the provider flags      {sum(1 for r in runs if r['holds_flagged_ids'])}")
    print("\n== Findings by tier (every finding on every card) ==")
    tier_table(runs)
    print("\n== Actionable findings (R3 kinds) ==")
    print(f"actionable findings                            {sum(lines(r, lambda l: l['actionable']) for r in runs)}")
    for v in VERDICTS:
        print(f"  verified {v:<37}{sum(lines(r, lambda l, v=v: l['actionable'] and l['verdict'] == v) for r in runs)}")
    kinds(runs)
    print(f"ids on a card the provider marks deprecated/retired/rerouted, card silent  {sum(r['flagged_silent'] for r in runs)}")
    false_by_kind = Counter()
    for r in runs:
        for l in r["lines"]:
            if l["tier"] == "certain" and l["verdict"] == "false":
                false_by_kind[l["kind"]] += l["count"]
    print("false certain lines by kind                    " + ", ".join(f"{k} {n}" for k, n in sorted(false_by_kind.items())))


def run_two(projects, run, label, bar):
    rs = rows_with(projects, run)
    runs = [r for _, r in rs]
    k = sum(1 for r in runs if ta(r) > 0)
    false_certain = sum(lines(r, lambda l: l["tier"] == "certain" and l["verdict"] == "false") for r in runs)
    k_any = sum(1 for r in runs if r["restated_true"] > 0)
    false_any = sum(lines(r, lambda l: l["verdict"] == "false") for r in runs)
    strict = sum(1 for p, r in rs if not p["strict_out"] and r["restated_true"] > 0)
    unverified_certain = sum(lines(r, lambda l: l["tier"] == "certain" and l["verdict"] == "not checkable") for r in runs)
    holds = sum(1 for r in runs if r["holds_flagged_ids"])
    print(f"== {label} ==")
    print(f"projects run                                   {len(rs)}")
    print(f"projects with a card                           {sum(1 for r in runs if r['card'])}")
    print(f"projects with >=1 true actionable finding      {k}")
    print(f"false certain lines (all cards)                {false_certain}")
    print(f"restated (Amendment C): projects with >=1 true actionable finding at certain or likely, verified on the provider's page   {k_any}")
    if bar:
        print(f"restated, strict (without the two weak cases: a fallback-list entry, a model-picker re-extract)   {strict}")
    print(f"restated: false lines at any tier              {false_any}")
    tiers = Counter()
    for r in runs:
        for l in r["lines"]:
            tiers[l["tier"]] += l["count"]
    print("lines by tier                                  " + ", ".join(f"{t} {tiers[t]}" for t in TIERS))
    print(f"certain lines not verified                     {unverified_certain}")
    if bar:
        verdict = "viable" if k_any >= 14 and false_any <= 1 else "not viable"
        print(f"R6 verdict                                     {verdict}  (restated: >=14 of 20 with a true actionable finding at either tier AND <=1 false line at any tier)")
    print(f"projects whose extract holds a provider-flagged id   {holds}")
    if label.startswith("A2"):
        reading = "not a beginner's pain alone" if holds >= 10 else ("mostly a beginner's" if holds < 5 else "unclear")
        print(f"A2 reading                                     {reading}  (>=10 not a beginner's alone; <5 mostly a beginner's; between unclear)")
    print(f"flagged ids on a card the card was silent about      {sum(r['flagged_silent'] for r in runs)}")
    print(f"provider-word lines at likely on a partner platform  {sum(r['partner_lines'] for r in runs)} (provider page checked true: {sum(r['partner_true'] for r in runs)})")
    print("\n== Findings by tier ==")
    tier_table(runs)
    act = {v: sum(lines(r, lambda l, v=v: l["actionable"] and l["verdict"] == v) for r in runs) for v in VERDICTS}
    print(f"\nactionable findings {sum(act.values())}: " + ", ".join(f"{v} {act[v]}" for v in VERDICTS))
    kinds(runs)
    return {"holds": holds, "k_any": k_any, "strict": strict, "act": sum(act.values()), "act_false": act["false"], "false_any": false_any}


def owners(projects):
    print("\n== Owner groups (aggregate only) ==")
    print(f"{'sample · group':<34}{'projects':>9}{'hold r1':>9}{'hold C':>8}{'true r1':>9}{'true C':>8}")
    for sample, name in (("first-20", "first 20"), ("experienced-20", "second 20")):
        for g in GROUPS:
            ps = [p for p in projects if p["sample"] == sample and p["owner_group"] == g]
            if not ps:
                continue
            r1 = [p["runs"].get("run1") for p in ps]
            c = [p["runs"]["after-c"] for p in ps]
            h1 = sum(1 for r in r1 if r and r["holds_flagged_ids"]) if sample == "first-20" else "-"
            t1 = sum(1 for r in r1 if r and ta(r) > 0) if sample == "first-20" else "-"
            print(f"{name + ' · ' + g:<34}{len(ps):>9}{h1:>9}{sum(1 for r in c if r['holds_flagged_ids']):>8}{t1:>9}{sum(1 for r in c if ta(r) > 0):>8}")


def main():
    projects = load()
    first = [p for p in projects if p["sample"] == "first-20"]
    exp = [p for p in projects if p["sample"] == "experienced-20"]
    named = [p for p in projects if p.get("name")]
    print(f"projects: {len(projects)} ({len(first)} + {len(exp)}); named {len(named)}, as project-NN {len(projects) - len(named)}")
    print()
    run_one(first)
    print()
    c1 = run_two(first, "after-c", "Run two, 0.4.0 (R6) after Amendment C", bar=True)
    print()
    run_two(exp, "first", "A2: the experienced sample, 0.4.0 (40d8b42, cold-read corrections applied)", bar=False)
    print()
    ac = run_two(exp, "after-c", "A2: the experienced sample, 0.4.0 after Amendment C", bar=False)
    owners(projects)
    print("\n== Star bands ==")
    for sample in ("first-20", "experienced-20"):
        print(f"  {sample:<16}" + ", ".join(f"{b} {sum(1 for p in projects if p['sample'] == sample and p['stars_band'] == b)}" for b in BANDS))
    print("\n== Both samples after Amendment C (the root README's figures) ==")
    dates = sorted({r["date"] for p in projects for r in p["runs"].values() if r and r.get("date")})
    print(f"runs dated                                     {', '.join(dates)}")
    print(f"projects, first sample / second sample         {len(first)} / {len(exp)}")
    print(f"R4 bar (first sample, run one)                 {R4_BAR} projects with a true actionable finding")
    print(f"run one, projects with a true actionable finding   {sum(1 for p in first if ta(p['runs']['run1']) > 0)} of {len(first)}")
    print(f"after C, first sample: restated / strict       {c1['k_any']} / {c1['strict']} of {len(first)}")
    print(f"after C, second sample holding a flagged id    {ac['holds']} of {len(exp)}")
    print(f"second sample, owner groups                    " + ", ".join(f"{g} {sum(1 for p in exp if p['owner_group'] == g)}" for g in GROUPS))
    print(f"after Amendment C, built by                    {load_doc().get('builds', {}).get('after-c', '-')}")
    print(f"projects named / as project-NN                 {len(named)} / {len(projects) - len(named)}")
    print(f"projects holding a provider-flagged id         {c1['holds'] + ac['holds']} of {len(projects)}")
    print(f"projects with a true actionable finding        {c1['k_any'] + ac['k_any']} of {len(projects)}")
    print(f"actionable lines printed                       {c1['act'] + ac['act']} (false {c1['act_false'] + ac['act_false']})")
    print(f"false lines at any tier                        {c1['false_any'] + ac['false_any']}")
    print("\n== Per project ==")
    for p in projects:
        who = f"{p['id']} {p['name']}" if p.get("name") else p["id"]
        r1 = p["runs"].get("run1")
        first_build = p["runs"].get("first")
        before = f"run1 true-actionable={ta(r1) if r1 else '-'}" if p["sample"] == "first-20" else f"first-build true-actionable={ta(first_build)}"
        c = p["runs"]["after-c"]
        print(f"{who:<40}{p['sample']:<16}{p['owner_group']:<21}{p['stars_band']:<17}{before:<34}after-c true-actionable={ta(c):<3} flagged-ids={c['holds_flagged_ids']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

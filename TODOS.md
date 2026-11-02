# TODOS

## healthEat

### Week rewriter (meal plan that regenerates on a gap)

**What:** A weekly meal plan (`Plan` model) that regenerates remaining days when today's log opens a nutrient gap or trips a sensitivity threshold.

**Why:** The most "alive" feature from office hours; cut from the 2026 fall plan at eng-review decision D3 to protect phases 0 to 3.

**Context:** Needs the 7-day coverage service and the "close the gap" ranking from phase 1 as inputs, plus a planning step that fills slots from cached Foods or a recipe source. Design it as its own /office-hours pass before building; the original sketch is in `docs/designs/healtheat-nutrient-coach.md` (Approaches and Next Steps, Phase 4).

**Effort:** L
**Priority:** P4
**Depends on:** Phases 1 and 2 shipped

## Completed

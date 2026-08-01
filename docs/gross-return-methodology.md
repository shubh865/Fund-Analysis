# Net versus gross return methodology

## Executive pitch

The Quartiles view can now answer two different questions:

- **Net return:** What did the investor actually earn after fund expenses?
- **Gross before TER:** How did the underlying portfolio perform before the expense ratio was deducted?

Published NAV is already net of scheme expenses. The platform therefore uses NAV for the investor return and reconstructs an estimated gross return by adding back the applicable daily TER drag. Direct and Regular plans use their own TER histories, but the same underlying portfolio should produce similar gross returns. This separates investment-management performance from the effect of plan cost.

The feature is useful for distinguishing three situations:

1. A fund performed well because the portfolio performed well.
2. A fund's portfolio performed well, but higher expenses reduced the investor outcome.
3. Two plans appear different on net return mainly because their costs differ.

## Simple illustration

Assume ₹100 invested becomes ₹110 based on published NAV. The investor earned 10% net. If approximately 1% TER was deducted through the year, the portfolio had to earn roughly ₹111.10 before expenses to leave ₹110 for the investor. The estimated gross return is therefore about 11.1%, not exactly 11%, because expenses are deducted gradually while the value compounds.

## Calculation used

For every scheme and selected holding period:

1. Find the actual available NAV on or before the calendar-year start date and the latest eligible NAV.
2. Calculate the net growth factor as `ending NAV / starting NAV`.
3. Select the plan-specific official TER: Direct TER for a Direct plan and Regular TER for a Regular plan.
4. Convert each annualized TER observation into a daily expense rate.
5. Compound the daily expense rates across the holding period to reconstruct the expense drag.
6. Multiply the NAV growth factor by the reconstructed expense factor.
7. Show the 1-year result as a total return; annualize 3-year and 5-year results using the actual elapsed calendar days.

In compact form:

`Gross growth factor = NAV growth factor × product of 1 / (1 − annual TER / 365.2425)`

The TER percentage is first divided by 100. The product is calculated for each applicable calendar day after the starting NAV date through the ending NAV date.

## Data-quality safeguards

- New NSDL/AMFI identities take priority over legacy identities when dates overlap.
- A TER source explicitly labelled Direct cannot be used for a Regular plan, or vice versa.
- Zero, negative, missing, or impossible TER values are not treated as valid expenses.
- Conflicting official observations are not averaged.
- A scheme is excluded from gross ranking when the selected period lacks complete, unambiguous TER coverage.
- Published outliers are retained when valid; the platform does not silently cap or invent data.
- Net return remains the default because it is the actual investor experience.

## How to present the result

“We have not replaced investor returns with a theoretical number. Net NAV return remains the primary result. The gross view is a diagnostic layer that removes the estimated TER drag, allowing us to compare portfolio execution separately from plan pricing. The quartile ranking is recalculated under either view, and any fund without reliable TER coverage is excluded rather than estimated.”

## Interpretation cautions

Gross before TER is an estimate based on AMFI's published annualized TER history and daily NAV. Small differences can remain between Direct and Regular gross results because of NAV rounding, disclosure timing, and source precision. It should be used for analytical comparison, not presented as an investor-realized return or an audited accounting return.

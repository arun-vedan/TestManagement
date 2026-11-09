// WP-133 — the sample project's content.
//
// This file is PROSE, deliberately separated from the code that loads it
// (api/sampleProjectApi.ts). It is the thing a human reviews for plausibility,
// which the WP's acceptance requires, and a reviewer should not have to read
// orchestration logic to do that.
//
// DOMAIN: online banking / payments, chosen by the owner. Regulated domains
// are where requirement-to-test evidence genuinely matters, so the
// traceability story lands with the people who care about it most.
//
// THE SAMPLE IS DELIBERATELY NOT ALL-GREEN. It ships one real failure, one
// blocked case, two unexecuted cases, one requirement with no test coverage at
// all, and one open high-severity defect linked to both a failing case and its
// requirement. An evaluator opening a flawless project learns nothing about
// the product: the entire point of coverage, traceability and release gates is
// to surface problems, and a dashboard with nothing to surface renders as
// decoration. The numbers below are chosen so every report has something real
// to say:
//
// Measured from an actual seeded project, not estimated:
//
//   coverage          8 requirements, 7 tested, 1 untested -> a real gap
//   traceability      8 rows; the transfer-limits row carries a case AND a defect
//   plan progress     13 cases: 9 pass, 1 fail, 1 blocked, 2 not run (11 executed)
//   pass rate         69.23%, which fails the release's 90% gate on purpose
//   release readiness 1 release, rolled up RED -- the gates actually evaluate
//   defect summary    1 open High
//
// Requirement lifecycle states are spread across draft/review/approved rather
// than all-approved, because a real backlog always is.

export interface SampleRequirement {
    key: string; // local handle, used to wire links; not the stored reqId
    summary: string;
    description: string;
    status: 'draft' | 'review' | 'approved';
}

export interface SampleStep {
    testStep: string;
    Expected: string;
}

export interface SampleTestCase {
    key: string;
    summary: string;
    description: string;
    covers: string[]; // requirement keys
    steps: SampleStep[];
    // Omitted entirely for the two cases left unexecuted, so "not run" is a
    // real state in the seeded run rather than a status string we invent.
    result?: 'pass' | 'fail' | 'blocked';
    // Attaches the shared step instead of spelling its steps out again.
    usesSharedStep?: boolean;
}

export const SAMPLE_PROJECT_NAME = 'Sample — Retail Banking Payments';

export const SAMPLE_REQUIREMENTS: SampleRequirement[] = [
    {
        key: 'payee',
        summary: 'Add and verify a new payee before any transfer is allowed',
        description:
            'A customer can add a domestic payee by sort code and account number. The payee stays in a ' +
            'pending state and cannot receive a transfer until verification completes, either by ' +
            'confirmation-of-payee name match or by two micro-deposits the customer confirms. ' +
            'Rejected name matches must be shown to the customer before they can proceed.',
        status: 'approved'
    },
    {
        key: 'limits',
        summary: 'Enforce daily transfer limits by account tier',
        description:
            'Each account tier carries a daily outbound limit: tier 1 £1,000, tier 2 £10,000, tier 3 ' +
            '£50,000. The limit applies to the sum of all transfers made in a rolling 24 hours, not to ' +
            'the individual transfer. A transfer that would breach the limit is declined before funds ' +
            'move, with the remaining allowance shown to the customer.',
        status: 'approved'
    },
    {
        key: 'stepup',
        summary: 'Require step-up authentication above £5,000',
        description:
            'Any single transfer of £5,000 or more requires a second factor at the point of payment, ' +
            'even within an authenticated session. The challenge is a one-time passcode to the ' +
            "customer's registered device. Three failed attempts lock the payment journey for 30 " +
            'minutes without locking the account itself.',
        status: 'approved'
    },
    {
        key: 'scheduled',
        summary: 'Schedule a future-dated transfer and allow cancellation',
        description:
            'A customer can schedule a transfer up to 12 months ahead and cancel it any time before ' +
            'the cut-off on the execution date. A scheduled transfer re-checks the balance and the ' +
            'daily limit at execution time, not at the time it was scheduled.',
        status: 'approved'
    },
    {
        key: 'insufficient',
        summary: 'Decline a transfer on insufficient available balance',
        description:
            'Available balance excludes uncleared funds and any held authorisations. A transfer that ' +
            'exceeds the available balance is declined without a partial debit, and the customer is ' +
            'told the available figure rather than the ledger balance.',
        status: 'approved'
    },
    {
        key: 'notify',
        summary: 'Notify the customer when a transfer completes or fails',
        description:
            'A push notification and an email are sent on completion and on failure, each naming the ' +
            'payee, the amount and the reference. Notification failure must not roll back a completed ' +
            'transfer, and must be retried independently.',
        status: 'review'
    },
    {
        key: 'statement',
        summary: 'Export a statement for a chosen period as PDF',
        description:
            'A customer can export any period up to 7 years as a PDF carrying the account number in ' +
            'masked form, the opening and closing balance, and every transaction in date order. ' +
            'Exports over 2,000 transactions are generated asynchronously and emailed as a link.',
        status: 'review'
    },
    {
        // Deliberately left with no test case, so coverage reports a real gap
        // rather than a vacuous 100%. A draft requirement with no tests yet is
        // also the most believable kind of gap.
        key: 'sanctions',
        summary: 'Block transfers to a sanctioned payee',
        description:
            'Every outbound transfer is screened against the current sanctions list before funds move. ' +
            'A positive match blocks the payment, raises a case for the financial crime team, and shows ' +
            'the customer a neutral message that does not disclose the match.',
        status: 'draft'
    }
];

export const SAMPLE_SHARED_STEP = {
    title: 'Sign in and complete two-factor authentication',
    description:
        'Reused by every case that starts from an authenticated session. Kept as a shared step so a ' +
        'change to the sign-in journey is made once rather than in each case.',
    steps: [
        { testStep: 'Open the banking app and enter a valid customer number', Expected: 'The passcode screen is shown' },
        { testStep: 'Enter the correct passcode', Expected: 'A one-time code is sent to the registered device' },
        { testStep: 'Enter the one-time code', Expected: 'The account overview is shown with the correct masked account number' }
    ]
};

export const SAMPLE_DATASET = {
    title: 'Transfer amounts by account tier',
    description:
        'Boundary values for the daily-limit and step-up rules. Used by the limit cases so the ' +
        'boundaries are data rather than copies of the same case.',
    columns: ['amount', 'tier', 'daily total so far', 'expected outcome'],
    rows: [
        ['999.00', 'tier 1', '0.00', 'allowed'],
        ['1000.00', 'tier 1', '0.00', 'allowed, limit exactly met'],
        ['1000.01', 'tier 1', '0.00', 'declined, over daily limit'],
        ['400.00', 'tier 1', '700.00', 'declined, rolling 24h total would breach'],
        ['5000.00', 'tier 2', '0.00', 'allowed, step-up challenge required'],
        ['10000.01', 'tier 2', '0.00', 'declined, over daily limit']
    ]
};

export const SAMPLE_TEST_CASES: SampleTestCase[] = [
    {
        key: 'payee-microdeposit',
        summary: 'A new payee cannot receive a transfer until micro-deposits are confirmed',
        description: 'Covers the pending-payee gate, which is the control that stops a mistyped account number moving money.',
        covers: ['payee'],
        usesSharedStep: true,
        steps: [
            { testStep: 'Add a payee with a valid sort code and account number', Expected: 'The payee is saved in Pending verification' },
            { testStep: 'Attempt a £10.00 transfer to the pending payee', Expected: 'The transfer is refused and the reason names verification as outstanding' },
            { testStep: 'Confirm the two micro-deposit amounts', Expected: 'The payee moves to Verified' },
            { testStep: 'Repeat the £10.00 transfer', Expected: 'The transfer completes and appears in the statement' }
        ],
        result: 'pass'
    },
    {
        key: 'payee-name-mismatch',
        summary: 'A confirmation-of-payee name mismatch is shown before the customer can continue',
        description: 'The customer must see the mismatch; silently proceeding is the failure mode this guards.',
        covers: ['payee'],
        usesSharedStep: true,
        steps: [
            { testStep: 'Add a payee whose name does not match the account record', Expected: 'A mismatch warning names the account holder returned by the bank' },
            { testStep: 'Attempt to continue without acknowledging the warning', Expected: 'The journey does not advance' },
            { testStep: 'Acknowledge the warning explicitly and continue', Expected: 'The payee is added, still in Pending verification' }
        ],
        result: 'pass'
    },
    {
        key: 'limit-tier1-within',
        summary: 'A tier 1 transfer within the daily limit is allowed',
        description: 'Boundary case driven by the transfer-amounts dataset, at and just under the tier 1 limit.',
        covers: ['limits'],
        usesSharedStep: true,
        steps: [
            { testStep: 'Transfer £999.00 from a tier 1 account with no prior transfers today', Expected: 'The transfer completes' },
            { testStep: 'Check the remaining allowance shown on the account', Expected: 'The remaining daily allowance reads £1.00' }
        ],
        result: 'pass'
    },
    {
        key: 'limit-tier2-over',
        summary: 'A tier 2 transfer over the daily limit is declined before funds move',
        description:
            'The case that currently fails. The limit is enforced, but at the wrong threshold, so a ' +
            'transfer the rules should decline is accepted.',
        covers: ['limits'],
        usesSharedStep: true,
        steps: [
            { testStep: 'Transfer £10,000.01 from a tier 2 account with no prior transfers today', Expected: 'The transfer is declined and names the daily limit as the reason' },
            { testStep: 'Check the account balance', Expected: 'The balance is unchanged, with no partial debit' }
        ],
        result: 'fail'
    },
    {
        key: 'limit-rolling-window',
        summary: 'The daily limit applies to the rolling 24-hour total, not the single transfer',
        description: 'Two transfers each individually within the limit must still breach it in combination.',
        covers: ['limits'],
        usesSharedStep: true,
        steps: [
            { testStep: 'Transfer £700.00 from a tier 1 account', Expected: 'The transfer completes' },
            { testStep: 'Transfer a further £400.00 within the same 24 hours', Expected: 'The second transfer is declined, naming the rolling total' }
        ],
        result: 'pass'
    },
    {
        key: 'stepup-triggered',
        summary: 'A £5,000 transfer triggers a step-up challenge inside an authenticated session',
        description: 'Being already signed in must not be enough at the payment threshold.',
        covers: ['stepup'],
        usesSharedStep: true,
        steps: [
            { testStep: 'Begin a £5,000.00 transfer to a verified payee', Expected: 'A one-time passcode challenge is presented before confirmation' },
            { testStep: 'Enter the correct passcode', Expected: 'The transfer completes' }
        ],
        result: 'pass'
    },
    {
        key: 'stepup-below',
        summary: 'A transfer just below the threshold does not trigger a step-up challenge',
        description: 'The negative half of the threshold. Without it, a challenge on every payment would pass the positive case and still be wrong.',
        covers: ['stepup'],
        usesSharedStep: true,
        steps: [
            { testStep: 'Begin a £4,999.99 transfer to a verified payee', Expected: 'No passcode challenge is presented' },
            { testStep: 'Confirm the transfer', Expected: 'The transfer completes' }
        ],
        result: 'pass'
    },
    {
        key: 'stepup-lockout',
        summary: 'Three failed step-up attempts lock the payment journey but not the account',
        description: 'Separates the payment lock from an account lock; conflating them is a support-call generator.',
        covers: ['stepup'],
        usesSharedStep: true,
        steps: [
            { testStep: 'Begin a £6,000.00 transfer and enter an incorrect passcode three times', Expected: 'The payment journey is locked and names a 30-minute wait' },
            { testStep: 'Return to the account overview', Expected: 'The account is still accessible and the balance is visible' }
        ],
        result: 'pass'
    },
    {
        key: 'scheduled-executes',
        summary: 'A future-dated transfer re-checks balance and limit at execution time',
        description: 'The re-check is the point: a transfer scheduled while in funds must not execute while overdrawn.',
        covers: ['scheduled'],
        usesSharedStep: true,
        steps: [
            { testStep: 'Schedule a £500.00 transfer for the next working day', Expected: 'The transfer is listed under Scheduled' },
            { testStep: 'Reduce the available balance below £500.00 before the execution date', Expected: 'The scheduled transfer still shows as Scheduled' },
            { testStep: 'Advance to the execution date and run the cut-off', Expected: 'The transfer fails for insufficient funds and the customer is notified' }
        ],
        result: 'pass'
    },
    {
        key: 'scheduled-cancel',
        summary: 'A scheduled transfer can be cancelled before the cut-off',
        description: 'Left unexecuted in this run: the scheduling harness was not available for the window.',
        covers: ['scheduled'],
        usesSharedStep: true,
        steps: [
            { testStep: 'Schedule a transfer for a date three days ahead', Expected: 'The transfer is listed under Scheduled' },
            { testStep: 'Cancel it on the day before execution', Expected: 'The transfer leaves the Scheduled list and no funds move' }
        ]
        // no result: not run
    },
    {
        key: 'insufficient-available',
        summary: 'Available balance excludes uncleared funds when a transfer is declined',
        description: 'The customer must be told the available figure, not the ledger figure.',
        covers: ['insufficient'],
        usesSharedStep: true,
        steps: [
            { testStep: 'Pay in a cheque so that ledger balance exceeds available balance', Expected: 'The account shows both figures distinctly' },
            { testStep: 'Attempt a transfer above the available balance but below the ledger balance', Expected: 'The transfer is declined and the message quotes the available balance' }
        ],
        result: 'pass'
    },
    {
        key: 'notify-on-completion',
        summary: 'A completed transfer sends both a push notification and an email',
        description:
            'Blocked in this run: the notification sandbox was unavailable, so the assertion could not ' +
            'be made either way. Recorded as blocked rather than failed, because nothing was observed.',
        covers: ['notify'],
        usesSharedStep: true,
        steps: [
            { testStep: 'Complete a £250.00 transfer to a verified payee', Expected: 'The transfer appears in the statement' },
            { testStep: 'Check the registered device and mailbox', Expected: 'Both carry the payee, amount and reference' }
        ],
        result: 'blocked'
    },
    {
        key: 'statement-pdf',
        summary: 'A statement export masks the account number and balances to the period',
        description: 'Left unexecuted in this run: pending sign-off on the masking format.',
        covers: ['statement'],
        usesSharedStep: true,
        steps: [
            { testStep: 'Export the previous calendar month as PDF', Expected: 'The PDF downloads and opens' },
            { testStep: 'Inspect the header and footer', Expected: 'The account number is masked and the opening and closing balances match the period' }
        ]
        // no result: not run
    }
];

// Linked to BOTH the failing case and the requirement it covers. That double
// link is what makes the traceability matrix show a requirement row carrying a
// test AND a defect, which is the thing a single link cannot demonstrate.
export const SAMPLE_DEFECT = {
    summary: 'Tier 2 daily transfer limit is enforced at £100,000 instead of £10,000',
    description:
        'A tier 2 account accepted a £10,000.01 transfer with no prior transfers in the window. The ' +
        'limit is applied, but against the tier 3 threshold: the tier lookup returns the highest ' +
        'configured tier when the account carries more than one product. Funds moved, so this is a ' +
        'control failure rather than a display bug.',
    severity: 'High',
    status: 'New',
    coversRequirement: 'limits',
    failsTestCase: 'limit-tier2-over'
};

export const SAMPLE_TEST_PLAN = {
    name: 'Release 1.0 — payments regression',
    description:
        'The regression set run before any payments release: payee verification, daily limits, ' +
        'step-up authentication, scheduling, and statement export.'
};

// Gates are set so they genuinely evaluate rather than pass vacuously. With
// 9 of 13 cases passing (69.23%), a 90% gate is NOT met, and one open High
// defect breaches a zero-tolerance gate. A release that shows green on a
// project with a known control failure would be the wrong first impression of
// what a quality gate is for.
export const SAMPLE_RELEASE = {
    name: '1.0 — Payments',
    status: 'planned',
    notes:
        'Blocked on the tier 2 limit defect. Both gates are evaluated against the regression run, ' +
        'so this release is deliberately not green while that defect is open.',
    qualityGates: [
        { type: 'minPassRate', threshold: 90 },
        { type: 'maxOpenDefects', threshold: 0, severity: 'High' }
    ]
};

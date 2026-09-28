// The news ticker: headlines made from the live numbers, in a voice that gets darker with every stage (a cheerful
// local paper for the garage, corporate spin in the middle, a captured press for the evil empire).
export interface NewsStats {
  stage: number;
  rats: number;
  frozen: number;
  fund: string;
  mcap: string;
  price: string;
  topStock: string;
  topRats: number;
  worstStock: string;
  worstPct: string;
  bestRat: string;
  bestPct: string;
}

type Line = (s: NewsStats) => string;

const n = (v: number): string => v.toLocaleString('en-US');

const BY_STAGE: Line[][] = [
  [
    (s) => `LOCAL GARAGE STARTUP HIRES ITS ${n(s.rats)}TH RAT, NEIGHBOURS "MILDLY CONCERNED"`,
    () => 'FOUNDERS COUNT THE LOOSE CHANGE IN THE VAULT TWICE A DAY',
    (s) => `${s.topStock} DESK OVERBOOKED: ${n(s.topRats)} RATS SHARE ONE COFFEE MACHINE`,
    () => 'GARAGE DOOR STAYS OPEN ALL NIGHT, CITY ISSUES FRIENDLY REMINDER',
  ],
  [
    () => 'SMALL OFFICE SIGNS LEASE, RATS DEMAND A SECOND COFFEE MACHINE',
    (s) => `${n(s.rats)} RATS NOW EMPLOYED. HR IS ONE RAT NAMED GARY`,
    (s) => `${s.bestRat} UP ${s.bestPct}, ASKS FOR A WINDOW SEAT`,
    () => 'OPEN PLAN OFFICE "FOSTERS COLLABORATION", SAYS NOBODY',
  ],
  [
    (s) => `FULL FLOOR: ${n(s.rats)} RATS, ${n(s.frozen)} FROZEN BY "MARKET CONDITIONS"`,
    (s) => `${s.worstStock} DESKS SLUMP ${s.worstPct} AS MORALE PLAYS ALONG`,
    () => 'SERVER ROOM FIRE CONTAINED, POSTMORTEM BLAMES A TOASTER',
    (s) => `PORTFOLIO WORTH ${s.fund}. RATS WORTH "PRICELESS", SAYS BROCHURE`,
  ],
  [
    () => 'CORPORATE FLOOR REACHED. MISSION STATEMENT NOW 40 PAGES',
    (s) => `ANALYSTS UPGRADE RAT TO "RATTY" AT ${s.price}`,
    (s) => `${n(s.frozen)} RATS FROZEN "FOR THEIR OWN GROWTH JOURNEY"`,
    () => 'MANDATORY FUN DAY MOVED TO SATURDAY FOR "SYNERGY"',
  ],
  [
    (s) => `MEGACORP SWALLOWS THREE CITY BLOCKS, RESIDENTS OFFERED ${s.topStock} STOCK`,
    (s) => `THE VAULT NOW HOLDS ${s.fund}. RATS ASKED TO STOP SWIMMING IN IT`,
    () => 'CITY RENAMES MAIN AVENUE "RAT RACE WAY" AFTER GENEROUS DONATION',
    (s) => `MARKET CAP ${s.mcap}. SMALL BUSINESSES "WELCOME TO APPLY" FOR DESKS`,
  ],
  [
    () => 'THE SKY IS RED NOW. THE BOARD CALLS IT "ON BRAND"',
    (s) => `${n(s.rats)} RATS. NONE MAY LEAVE. RETENTION AT AN ALL-TIME HIGH`,
    () => 'CITY COUNCIL NOW A WHOLLY OWNED SUBSIDIARY',
    (s) => `${n(s.frozen)} RATS FROZEN FOREVER. "PERFORMANCE REVIEW", SAYS HR`,
    (s) => `THE VAULT HAS SWALLOWED ${s.fund} AND IS STILL HUNGRY`,
  ],
];

const ALWAYS: Line[] = [
  (s) => `RAT ${s.price} . MCAP ${s.mcap} . VAULT ${s.fund}`,
  (s) => `TOP DESK: ${s.topStock} WITH ${n(s.topRats)} RATS`,
];

/** A fresh set of headlines for the ticker. */
export function headlines(s: NewsStats): string[] {
  const own = BY_STAGE[Math.max(0, Math.min(BY_STAGE.length - 1, s.stage))]!;
  const prev = s.stage > 0 ? BY_STAGE[s.stage - 1]!.slice(0, 1) : [];
  return [...own, ...prev, ...ALWAYS].map((f) => f(s)).filter((t) => !t.includes('undefined') && !t.includes('NaN'));
}

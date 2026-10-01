// The news ticker: headlines made from the live numbers, in a voice that gets darker with every stage (a cheerful
// local paper for the garage, corporate spin in the middle, a captured press on Wall Street).
import { ordinal } from './format';

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
    (s) => `LOCAL GARAGE STARTUP HIRES ITS ${ordinal(s.rats).toUpperCase()} INU, NEIGHBOURS "MILDLY CONCERNED" ABOUT THE BARKING`,
    () => 'FOUNDERS COUNT THE LOOSE CHANGE IN THE VAULT TWICE A DAY, THEN CHECK UNDER THE DOG BED',
    (s) => `${s.topStock} DESK OVERBOOKED: ${n(s.topRats)} INUS SHARE ONE WATER BOWL`,
    () => 'GARAGE DOOR STAYS OPEN ALL NIGHT, ENTIRE STAFF BARKS AT THE MAIL CARRIER',
  ],
  [
    () => 'SMALL OFFICE SIGNS LEASE, INUS DEMAND A SECOND WATER BOWL',
    (s) => `${n(s.rats)} INUS NOW EMPLOYED. HR IS ONE CORGI NAMED GARY`,
    (s) => `${s.bestRat} UP ${s.bestPct}, ASKS FOR A WINDOW SEAT AND A BELLY RUB`,
    () => 'OPEN PLAN OFFICE "FOSTERS COLLABORATION", SAYS NOBODY. "MUCH WOW", SAYS EVERYBODY',
  ],
  [
    (s) => `FULL FLOOR: ${n(s.rats)} INUS, ${n(s.frozen)} TOLD TO STAY BY "MARKET CONDITIONS"`,
    (s) => `${s.worstStock} DESKS SLUMP ${s.worstPct}, TAILS KEEP WAGGING OUT OF HABIT`,
    () => 'SERVER ROOM FIRE CONTAINED, POSTMORTEM BLAMES A CHEWED CABLE',
    (s) => `PORTFOLIO WORTH ${s.fund}. INUS WORTH "PRICELESS", SAYS BROCHURE`,
    () => 'JUNIOR ANALYST CHEWS THROUGH THE BLOOMBERG TERMINAL, CALLS IT "DUE DILIGENCE"',
  ],
  [
    () => 'CORPORATE FLOOR REACHED. MISSION STATEMENT NOW 40 PAGES, MOSTLY CHEWED',
    () => 'ANALYSTS RATE THE OFFICE "VERY GOOD BOY". NO FURTHER QUESTIONS',
    (s) => `${n(s.frozen)} INUS FROZEN "FOR THEIR OWN GROWTH JOURNEY"`,
    () => 'MANDATORY FUN DAY MOVED TO SATURDAY. WALKIES CANCELLED FOR "SYNERGY"',
    () => 'COMPLIANCE BANS SQUIRREL WATCHING DURING MARKET HOURS',
  ],
  [
    (s) => `MEGACORP SWALLOWS THREE CITY BLOCKS, RESIDENTS OFFERED ${s.topStock} STOCK AND A CHEW TOY`,
    (s) => `THE VAULT NOW HOLDS ${s.fund}. INUS ASKED TO STOP BURYING BONES IN IT`,
    () => 'CITY RENAMES MAIN AVENUE "WALL STREET INU WAY" AFTER GENEROUS DONATION',
    (s) => `MARKET CAP ${s.mcap}. SMALL BUSINESSES "WELCOME TO APPLY" FOR DESKS`,
    () => 'TRADING FLOOR BARKS AT THE MARKET FOR SIX HOURS. MARKET DOES NOT FETCH',
  ],
  [
    () => 'THE SKY IS RED NOW. THE BOARD CALLS IT "ON BRAND"',
    (s) => `${n(s.rats)} INUS. NONE MAY LEAVE. THE LEASH IS NOW A "RETENTION PROGRAM"`,
    () => 'CITY COUNCIL NOW A WHOLLY OWNED SUBSIDIARY. THE MAYOR SITS WHEN TOLD',
    (s) => `${n(s.frozen)} INUS FROZEN FOREVER. "PERFORMANCE REVIEW", SAYS HR`,
    (s) => `THE VAULT HAS SWALLOWED ${s.fund} AND IS STILL HUNGRY. NO TREATS FOR STAFF`,
  ],
];

/** Before the first hire (launch day, the first minutes): nothing to count yet, so no "0TH INU" or "0 INUS". */
const NO_RATS_YET: Line[] = [
  () => 'LOCAL GARAGE STARTUP OPENS ITS DOORS. FIRST INU HIRED AS SOON AS THE FEES COVER ONE SALARY',
  () => 'FOUNDERS SWEEP THE GARAGE, PRACTICE SAYING "SYNERGY" TO AN EMPTY DOG BED',
  () => 'JOB AD POSTED: "MUST LOVE STOCKS. NO TREAT BREAKS"',
];

const ALWAYS: Line[] = [
  (s) => `WSI ${s.price} . MCAP ${s.mcap} . VAULT ${s.fund}`,
  (s) => `TOP DESK: ${s.topStock} WITH ${n(s.topRats)} INUS`,
];

/** A fresh set of headlines for the ticker. */
export function headlines(s: NewsStats): string[] {
  if (s.rats === 0) return [...NO_RATS_YET, ALWAYS[0]!].map((f) => f(s)).filter((t) => !t.includes('undefined') && !t.includes('NaN'));
  const own = BY_STAGE[Math.max(0, Math.min(BY_STAGE.length - 1, s.stage))]!;
  const prev = s.stage > 0 ? BY_STAGE[s.stage - 1]!.slice(0, 1) : [];
  return [...own, ...prev, ...ALWAYS].map((f) => f(s)).filter((t) => !t.includes('undefined') && !t.includes('NaN'));
}

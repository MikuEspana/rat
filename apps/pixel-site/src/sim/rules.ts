// The backend's spending rules, as the launch simulator runs them. These are the worker's defaults from
// packages/core/src/config.ts; rules.test.ts loads the real config and fails if the two ever drift apart.
export const RULES = {
  /** CLAIM_INTERVAL_SEC: one claim + hire loop */
  loopSec: 35,
  /** HIRE_SPLIT_BPS: share of every claim that pays for hires (all of it); any rest would go to buy and burn */
  hireSplitBps: 10_000,
  /** SALARY_SOL: what one hire costs, all in */
  salarySol: 0.03,
  /** HIRE_OVERHEAD_EST_SOL + RAT_BUFFER_SOL come out of the salary; the rest is swapped into the stock */
  hireOverheadSol: 0.0025,
  ratBufferSol: 0.003,
  /** MAX_HIRES_PER_LOOP */
  maxHiresPerLoop: 10,
  /** MIN_CLAIM_SOL: smaller claimable balances wait for the next loop */
  minClaimSol: 0.005,
  /** MIN_BURN_SOL: smaller burn rounds wait */
  minBurnSol: 0.01,
  /** MIN_STOCK_WEIGHT_BPS: every stock gets at least 5% of new hires */
  minStockWeightBps: 500,
  /** SPEND_CAP_SOL_PER_HOUR_HIRE / _BURN: rolling hour; the rest waits and is spent later */
  capHireSolPerHour: 30,
  capBurnSolPerHour: 30,
  /** BURN_INTERVAL_MIN_SEC / MAX: a random 8 to 12 minutes between burn rounds */
  burnMinSec: 480,
  burnMaxSec: 720,
  /** BURN_CHUNK_MAX_SOL, BURN_ROUND_MAX_SOL, BURN_CHUNK_GAP_MIN_SEC / MAX */
  burnChunkMaxSol: 1,
  burnRoundMaxSol: 5,
  chunkGapMinSec: 3,
  chunkGapMaxSec: 8,
  /** PRICE_INTERVAL_SEC: stock prices refresh */
  priceSec: 15,
  /** SLIPPAGE_BPS_COIN: the burn buy accepts up to 1.5% less RAT than quoted */
  slippageBpsCoin: 150,
} as const;

/** SOL swapped into the stock per hire (salary minus the fee estimate and the rat's SOL buffer). */
export const SWAP_SOL = RULES.salarySol - RULES.hireOverheadSol - RULES.ratBufferSol;

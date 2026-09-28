// The backend's spending rules, as the launch simulator runs them. These are the worker's defaults from
// packages/core/src/config.ts; rules.test.ts loads the real config and fails if the two ever drift apart.
// Every claimed SOL goes to hiring rats: nothing is bought back or burned.
export const RULES = {
  /** CLAIM_INTERVAL_SEC: one claim + hire loop */
  loopSec: 35,
  /** SALARY_SOL: what one hire costs, all in */
  salarySol: 0.03,
  /** HIRE_OVERHEAD_EST_SOL + RAT_BUFFER_SOL come out of the salary; the rest is swapped into the stock */
  hireOverheadSol: 0.0025,
  ratBufferSol: 0.003,
  /** MAX_HIRES_PER_LOOP */
  maxHiresPerLoop: 20,
  /** MIN_CLAIM_SOL: smaller claimable balances wait for the next loop */
  minClaimSol: 0.005,
  /** MIN_STOCK_WEIGHT_BPS: every stock gets at least 5% of new hires */
  minStockWeightBps: 500,
  /** SPEND_CAP_SOL_PER_HOUR_HIRE: rolling hour; the rest waits and is spent later */
  capHireSolPerHour: 60,
  /** PRICE_INTERVAL_SEC: stock prices refresh */
  priceSec: 15,
} as const;

/** SOL swapped into the stock per hire (salary minus the fee estimate and the rat's SOL buffer). */
export const SWAP_SOL = RULES.salarySol - RULES.hireOverheadSol - RULES.ratBufferSol;

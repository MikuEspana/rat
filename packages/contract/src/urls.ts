export function solscanAccountUrl(address: string): string {
  return `https://solscan.io/account/${address}`;
}

export function solscanTxUrl(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}

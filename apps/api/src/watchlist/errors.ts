export class InvalidAddressError extends Error {
  constructor(raw: string, public readonly reasons: string[]) {
    super(`not a recognised address: ${raw}`);
  }
}

export class WatchlistNotFoundError extends Error {
  constructor(id: string) {
    super(`watchlist item not found: ${id}`);
  }
}

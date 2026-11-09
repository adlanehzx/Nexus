export interface TradingVenueConfig {
  id: "binance" | "kraken" | "ibkr";
  environment: "testnet" | "production";
  quoteCurrency: string;
  accountId: string;
  gatewayUrl: string;
  symbols: { symbol: string; baseAsset: string }[];
  allocatedCapital: number;
  maxOrderSize: number;
  maxPositionSize: number;
  maxDailyLoss: number;
  maxDrawdown: number;
  kellyFraction: number;
  allowedOrderTypes: "limit"[];
  manualConfirmation: boolean;
}
export interface TradingConfig {
  mode: "virtual" | "live";
  enabled: boolean;
  venues: TradingVenueConfig[];
}
export interface TradingStatus {
  config: TradingConfig;
  killed: boolean;
  killErrors: string[];
  productionConfirmedAt: Record<string, string>;
  audit: { entries: number; head: string | null };
  venues: Record<
    string,
    {
      cash: number;
      equity: number;
      error: string | null;
      positions: { symbol: string; quantity: number }[];
      orders: { id: string; symbol: string; quantity: number; price: number; status: string }[];
      history: { at: string; equity: number; cash?: number; exposure?: number }[];
    } | null
  >;
}
export const defaultTradingVenue = (): TradingVenueConfig => ({
  id: "binance",
  environment: "testnet",
  quoteCurrency: "USDT",
  accountId: "",
  gatewayUrl: "https://localhost:5000",
  symbols: [{ symbol: "BTCUSDT", baseAsset: "BTC" }],
  allocatedCapital: 1000,
  maxOrderSize: 20,
  maxPositionSize: 100,
  maxDailyLoss: 30,
  maxDrawdown: 0.1,
  kellyFraction: 0.25,
  allowedOrderTypes: ["limit"],
  manualConfirmation: true,
});

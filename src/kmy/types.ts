/**
 * Typed views over the KMyMoney XML document.
 *
 * The underlying parser keeps a preserve-order AST so unknown attributes and
 * elements (KEYVALUEPAIRS we don't understand, new XML versions, etc.) round-
 * trip unchanged. These interfaces are what tool handlers read and return.
 *
 * Amounts are always kept as rational strings ("12345/100") in the document.
 * Typed views expose them both raw and as decimal strings with the account or
 * currency precision.
 */

/** KMyMoney account type codes (partial — these are the common ones). */
export enum AccountType {
  Checking = 1,
  Savings = 2,
  Cash = 3,
  CreditCard = 4,
  Loan = 5,
  CertificateDeposit = 6,
  Investment = 7,
  MoneyMarket = 8,
  AssetRoot = 9,
  LiabilityRoot = 10,
  Currency = 11,
  Income = 12,
  Expense = 13,
  Asset = 14,
  Liability = 15,
  Equity = 16,
}

export const ACCOUNT_TYPE_NAMES: Record<number, string> = {
  1: "Checking",
  2: "Savings",
  3: "Cash",
  4: "CreditCard",
  5: "Loan",
  6: "CertificateDeposit",
  7: "Investment",
  8: "MoneyMarket",
  9: "AssetRoot",
  10: "LiabilityRoot",
  11: "Currency",
  12: "Income",
  13: "Expense",
  14: "Asset",
  15: "Liability",
  16: "Equity",
};

export const ASSET_LIKE = new Set([
  AccountType.Checking,
  AccountType.Savings,
  AccountType.Cash,
  AccountType.Asset,
  AccountType.Investment,
  AccountType.MoneyMarket,
  AccountType.CertificateDeposit,
]);

export const LIABILITY_LIKE = new Set([
  AccountType.CreditCard,
  AccountType.Loan,
  AccountType.Liability,
]);

export const INCOME_TYPES = new Set([AccountType.Income]);
export const EXPENSE_TYPES = new Set([AccountType.Expense]);

export interface FileInfo {
  creationDate: string;
  lastModifiedDate: string;
  version: string;
  fixVersion: string;
}

export interface User {
  name: string;
  email: string;
  address?: {
    street?: string;
    city?: string;
    county?: string;
    zipcode?: string;
    telephone?: string;
  };
}

export interface Institution {
  id: string;
  name: string;
  sortcode?: string;
  manager?: string;
  address?: Record<string, string>;
  accountIds: string[];
  keyValues: Record<string, string>;
}

export interface Payee {
  id: string;
  name: string;
  email?: string;
  reference?: string;
  defaultAccountId?: string;
  matchingEnabled?: boolean;
  matchIgnoreCase?: boolean;
  matchKey?: string;
  address?: Record<string, string>;
}

export interface Tag {
  id: string;
  name: string;
  closed: boolean;
  color?: string;
  notes?: string;
}

export interface Account {
  id: string;
  name: string;
  type: number;
  typeName: string;
  currency: string;
  parentAccount: string;
  institution?: string;
  number?: string;
  opened?: string;
  lastReconciled?: string;
  lastModified?: string;
  description?: string;
  subAccountIds: string[];
  keyValues: Record<string, string>;
}

export interface Split {
  id: string;
  account: string;
  shares: string; // rational
  value: string; // rational, in transaction commodity
  price: string; // rational
  memo?: string;
  payee?: string;
  action?: string;
  reconcileFlag?: string;
  reconcileDate?: string;
  number?: string;
  bankId?: string;
  tags: string[];
  keyValues: Record<string, string>;
}

export interface Transaction {
  id: string;
  postDate: string;
  entryDate: string;
  commodity: string;
  memo?: string;
  splits: Split[];
  keyValues: Record<string, string>;
}

export interface Currency {
  id: string;
  name: string;
  symbol: string;
  scf: string;
  saf: string;
  pp: string;
  type: string;
  roundingMethod: string;
}

export interface Security {
  id: string;
  name: string;
  symbol: string;
  type: string;
  tradingCurrency: string;
  tradingMarket?: string;
  saf: string;
  pp: string;
  roundingMethod: string;
  keyValues: Record<string, string>;
}

export interface Price {
  from: string;
  to: string;
  date: string;
  price: string; // rational
  source?: string;
}

export interface BudgetPeriod {
  amount: string; // rational
  start?: string;
}

export interface BudgetAccount {
  id: string;
  budgetLevel: string;
  amount: string; // rational (if level is total)
  periods: BudgetPeriod[];
}

export interface Budget {
  id: string;
  name: string;
  start: string;
  version: string;
  accounts: BudgetAccount[];
}

export interface Schedule {
  id: string;
  name: string;
  type: string;
  occurence?: string;
  occurenceMultiplier?: string;
  startDate?: string;
  endDate?: string;
  lastPayment?: string;
  weekendOption?: string;
  autoEnter?: boolean;
  fixed?: boolean;
  transaction?: Transaction;
  payments: string[];
}

export interface FileSummary {
  fileInfo: FileInfo;
  user: User;
  counts: Record<string, number>;
}

/* App Store prices, compiled from the two App Store Connect exports kept at
 * data/price-monthly.csv and data/price-yearly.csv (175 storefronts each).
 *
 * ONLY THE STOREFRONTS THAT PRICE IN THEIR OWN CURRENCY. Apple bills 109 of the
 * 175 in US dollars, because it runs no local-currency storefront there, and a
 * picker that answers "Kenya" with a USD figure is not telling a Kenyan what
 * their currency costs. Those are covered by one line under the picker instead.
 * The United States keeps its row: USD is its own currency. 66 + 1 = 67 rows.
 *
 * IN THE SHIPPED CLIENTS THESE NUMBERS ARE NEVER HARDCODED. P04: "Price
 * display: localized from the store." This table exists only so the web page
 * can show a figure before a store SDK has answered. Keep that boundary: it is
 * what the page prints, never what anybody is charged.
 *
 * Row shape: [country, currency, monthly, yearly, decimalPlaces]
 */

export const SYM = {
  AED: 'AED', AUD: 'A$', BRL: 'R$', CAD: 'C$', CHF: 'CHF', CLP: 'CLP$', CNY: 'CN¥',
  COP: 'COP$', CZK: 'Kč', DKK: 'kr', EGP: 'E£', EUR: '€', GBP: '£', HKD: 'HK$',
  HUF: 'Ft', IDR: 'Rp', ILS: '₪', INR: '₹', JPY: '¥', KRW: '₩', KZT: '₸',
  MXN: 'MX$', MYR: 'RM', NGN: '₦', NOK: 'kr', NZD: 'NZ$', PEN: 'S/', PHP: '₱',
  PKR: '₨', PLN: 'zł', QAR: 'QR', RON: 'lei', RUB: '₽', SAR: 'SR', SEK: 'kr',
  SGD: 'S$', THB: '฿', TRY: '₺', TWD: 'NT$', TZS: 'TSh', USD: 'US$', VND: '₫', ZAR: 'R',
};

/* Decimals belong to the CURRENCY, not to how the export printed the number:
 * zero for JPY, KRW, VND, IDR, HUF, CLP, COP, TWD, TZS, PKR, NGN, KZT and RUB,
 * two for everything else. So Switzerland reads "CHF 35.00", not "CHF35". */
export const ROWS = [
  ['Australia', 'AUD', 9.99, 59.99, 2],
  ['Austria', 'EUR', 6.99, 44.99, 2],
  ['Belgium', 'EUR', 6.99, 44.99, 2],
  ['Bosnia and Herzegovina', 'EUR', 6.99, 44.99, 2],
  ['Brazil', 'BRL', 39.9, 249.9, 2],
  ['Bulgaria', 'EUR', 6.99, 44.99, 2],
  ['Canada', 'CAD', 7.99, 49.99, 2],
  ['Chile', 'CLP', 6990, 49990, 0],
  ['China mainland', 'CNY', 38, 298, 2],
  ['Colombia', 'COP', 29900, 199900, 0],
  ['Croatia', 'EUR', 6.99, 44.99, 2],
  ['Cyprus', 'EUR', 6.99, 44.99, 2],
  ['Czech Republic', 'CZK', 149, 999, 2],
  ['Denmark', 'DKK', 49, 349, 2],
  ['Egypt', 'EGP', 299.99, 1999.99, 2],
  ['Estonia', 'EUR', 6.99, 44.99, 2],
  ['Finland', 'EUR', 6.99, 44.99, 2],
  ['France', 'EUR', 6.99, 44.99, 2],
  ['Germany', 'EUR', 6.99, 44.99, 2],
  ['Greece', 'EUR', 6.99, 44.99, 2],
  ['Hong Kong', 'HKD', 48, 288, 2],
  ['Hungary', 'HUF', 2490, 17990, 0],
  ['India', 'INR', 599, 3999, 2],
  ['Indonesia', 'IDR', 99000, 699000, 0],
  ['Ireland', 'EUR', 6.99, 44.99, 2],
  ['Israel', 'ILS', 19.9, 149.9, 2],
  ['Italy', 'EUR', 6.99, 44.99, 2],
  ['Japan', 'JPY', 1000, 6000, 0],
  ['Kazakhstan', 'KZT', 3490, 22990, 0],
  ['Korea, Republic of', 'KRW', 9900, 66000, 0],
  ['Kosovo', 'EUR', 6.99, 44.99, 2],
  ['Latvia', 'EUR', 6.99, 44.99, 2],
  ['Lithuania', 'EUR', 6.99, 44.99, 2],
  ['Luxembourg', 'EUR', 6.99, 44.99, 2],
  ['Malaysia', 'MYR', 29.9, 199.9, 2],
  ['Malta', 'EUR', 6.99, 44.99, 2],
  ['Mexico', 'MXN', 129, 899, 2],
  ['Montenegro', 'EUR', 5.99, 39.99, 2],
  ['Netherlands', 'EUR', 6.99, 44.99, 2],
  ['New Zealand', 'NZD', 9.99, 69.99, 2],
  ['Nigeria', 'NGN', 9900, 69900, 0],
  ['Norway', 'NOK', 79, 499, 2],
  ['Pakistan', 'PKR', 1700, 9900, 0],
  ['Peru', 'PEN', 24.9, 179.9, 2],
  ['Philippines', 'PHP', 399, 2490, 2],
  ['Poland', 'PLN', 29.99, 199.99, 2],
  ['Portugal', 'EUR', 6.99, 44.99, 2],
  ['Qatar', 'QAR', 19.99, 149.99, 2],
  ['Romania', 'RON', 29.99, 199.99, 2],
  ['Russia', 'RUB', 499, 3490, 0],
  ['Saudi Arabia', 'SAR', 24.99, 179.99, 2],
  ['Serbia', 'EUR', 6.99, 44.99, 2],
  ['Singapore', 'SGD', 8.98, 59.98, 2],
  ['Slovakia', 'EUR', 6.99, 44.99, 2],
  ['Slovenia', 'EUR', 6.99, 44.99, 2],
  ['South Africa', 'ZAR', 119.99, 799.99, 2],
  ['Spain', 'EUR', 6.99, 44.99, 2],
  ['Sweden', 'SEK', 79, 499, 2],
  ['Switzerland', 'CHF', 5, 35, 2],
  ['Taiwan', 'TWD', 190, 1290, 0],
  ['Tanzania', 'TZS', 17900, 99900, 0],
  ['Thailand', 'THB', 199, 1490, 2],
  ['Türkiye', 'TRY', 299.99, 1999.99, 2],
  ['United Arab Emirates', 'AED', 22.99, 149.99, 2],
  ['United Kingdom', 'GBP', 5.99, 39.99, 2],
  ['United States', 'USD', 5.99, 39.99, 2],
  ['Vietnam', 'VND', 199000, 1199000, 0],
];

export const DEFAULT_COUNTRY = 'United States';

/** The row for a country, falling back to the default storefront. */
export function priceRow(country) {
  return (
    ROWS.find((r) => r[0] === country) || ROWS.find((r) => r[0] === DEFAULT_COUNTRY)
  );
}

/**
 * Typeset one amount in a row's currency.
 *
 * "CHF 35.00", not "CHF35": a symbol that ends in a letter runs into the
 * numeral without a non-breaking space. A glyph symbol (£, ¥, R$) sits tight,
 * as it should. Free is typeset the same way everywhere: a bare zero, never
 * "0.00".
 */
export function fmt(row, amount) {
  const sym = SYM[row[1]];
  const gap = /\p{L}$/u.test(sym) ? ' ' : '';
  if (amount === 0) return sym + gap + '0';
  return (
    sym +
    gap +
    amount.toLocaleString('en-US', {
      minimumFractionDigits: row[4],
      maximumFractionDigits: row[4],
    })
  );
}

/** The USD line under the picker, typeset through the same formatter. */
const USD_ROW = ['', 'USD', 0, 0, 2];
export const usdMonthly = fmt(USD_ROW, 5.99);
export const usdYearly = fmt(USD_ROW, 39.99);

/** The yearly price expressed as a monthly one, on the currency's own grid. */
export function yearlyPerMonth(row) {
  const yearly = row[3];
  return row[4] === 0 ? Math.round(yearly / 12) : Math.round((yearly / 12) * 100) / 100;
}

/** How much less a year costs than twelve months, as a whole percent. */
export function savePercent(row) {
  return Math.round((1 - row[3] / (row[2] * 12)) * 100);
}

/** The one price line the home page and the upgrade gate both print. */
export function heroPriceLine(row) {
  return `Free to log, forever. Pro is ${fmt(row, row[2])} a month or ${fmt(row, row[3])} a year.`;
}

export function proPriceLine(row) {
  return `${fmt(row, row[2])} a month or ${fmt(row, row[3])} a year. No free trial.`;
}

/* The reader's storefront is remembered so every page quotes the same one. */
const KEY = 'jotlift.country';

export function savedCountry() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && ROWS.some((r) => r[0] === saved)) return saved;
  } catch {
    /* storage blocked; fall through to the default storefront */
  }
  return DEFAULT_COUNTRY;
}

export function saveCountry(country) {
  try {
    localStorage.setItem(KEY, country);
  } catch {
    /* the picker still works, it just is not remembered */
  }
}

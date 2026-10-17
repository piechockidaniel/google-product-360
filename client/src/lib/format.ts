import { useMemo } from 'react';
import { useI18n, type Lang } from './i18n';
import { translate } from './i18n';

export function formatDate(value: string | null | undefined, locale = 'pl-PL'): string {
  if (!value) return '–';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

export function timeAgo(value: string | null | undefined, lang: Lang = 'pl'): string {
  if (!value) return '–';
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return translate(lang, 'common.justNow');
  if (minutes < 60) return translate(lang, 'common.minAgo', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return translate(lang, 'common.hoursAgo', { n: hours });
  return translate(lang, 'common.daysAgo', { n: Math.round(hours / 24) });
}

export function formatPrice(price: { amountMicros: string; currencyCode: string } | null | undefined, locale = 'pl-PL'): string {
  if (!price) return '–';
  const amount = Number(price.amountMicros) / 1_000_000;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: price.currencyCode }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${price.currencyCode}`;
  }
}

/** Locale-aware formatters bound to the current UI language. */
export function useFormat() {
  const { lang, locale } = useI18n();
  return useMemo(
    () => ({
      formatDate: (v: string | null | undefined) => formatDate(v, locale),
      timeAgo: (v: string | null | undefined) => timeAgo(v, lang),
      formatPrice: (p: { amountMicros: string; currencyCode: string } | null | undefined) => formatPrice(p, locale),
      formatNumber: (n: number) => n.toLocaleString(locale),
    }),
    [lang, locale],
  );
}

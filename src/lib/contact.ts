import { normalizePhone } from '../domain/customers';

/** Israeli local number → international digits for wa.me (050-1234567 → 972501234567). */
export function internationalDigits(phone: string | null | undefined): string | null {
  const d = normalizePhone(phone);
  if (!d || d.length < 9) return null;
  if (d.startsWith('0')) return `972${d.slice(1)}`;
  return d;
}

/** One-click WhatsApp link with a prefilled message (no paid API — opens WhatsApp). */
export function whatsappLink(phone: string | null | undefined, text: string): string | null {
  const intl = internationalDigits(phone);
  return intl ? `https://wa.me/${intl}?text=${encodeURIComponent(text)}` : null;
}

export function telLink(phone: string | null | undefined): string | null {
  const d = normalizePhone(phone);
  return d ? `tel:${d}` : null;
}

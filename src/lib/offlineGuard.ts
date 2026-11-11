import type { Backend } from '../data/backend';
import { AppError } from '../data/backend';

/** Every operation that changes data. While offline these are refused (no unsafe offline queue). */
export const MUTATING: (keyof Backend)[] = [
  'createAppointment',
  'updateAppointment',
  'deleteAppointment',
  'setSplit',
  'updateShopHours',
  'setAppointmentStatus',
  'updateCustomer',
  'createSeries',
  'cancelSeries',
  'updateSeriesFuture',
  'updateClosedWeekdays',
  'saveWaitlistRequest',
  'setWaitlistStatus',
  'createOffer',
  'setOfferStatus',
  'acceptOffer',
];

/** Wraps a backend so that writes fail fast with OFFLINE when there is no connection. */
export function withOfflineGuard(backend: Backend, isOnline: () => boolean): Backend {
  return new Proxy(backend, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (MUTATING.includes(prop as keyof Backend)) {
        return (...args: unknown[]) => {
          if (!isOnline()) return Promise.reject(new AppError('OFFLINE'));
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
}

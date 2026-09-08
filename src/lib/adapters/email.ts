// Email adapter — nodemailer SMTP today, swap target is a provider API
// (Resend, Postmark, Amazon SES) once volume justifies it.
//
// The interface this module exposes is the contract the rest of the app
// depends on. The current implementation lives in `lib/email.ts`.
//
// Adapter contract:
//   sendBookingStatusEmail(booking, status, extras?)
//   sendNewBookingAdminNotification(booking)
//   sendBookingReminderEmail(booking)
//   sendPaymentRetryEmail(booking, url, minutes)
//   sendRepeatDiscountEmail(booking, code, percent, expiresAt)
//   sendTestEmail(config, to)
//
// What "deciding to swap" looks like:
//   1. Implement the same exports in `lib/email-resend.ts` calling Resend's
//      HTTP API (or wherever).
//   2. Change the re-exports below to point at it.
//   3. The current HTML-string templates in `lib/email.ts` are portable —
//      every provider takes raw HTML — so the template code stays.

export {
  sendBookingStatusEmail,
  sendNewBookingAdminNotification,
  sendBookingReminderEmail,
  sendPaymentRetryEmail,
  sendRepeatDiscountEmail,
  sendTestEmail,
} from '@/lib/email';

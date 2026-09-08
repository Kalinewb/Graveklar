import nodemailer from 'nodemailer';
import type { Booking, QuoteRequest, Machine } from '@prisma/client';
import { loadAppConfig } from '@/lib/app-config';
import { loadConfigValues } from '@/lib/config-server';
import { readMvaSettings, splitMva } from '@/lib/mva';
import { db } from '@/lib/db';

type BookingWithExtras = Booking & {
  cancellationFee?: number | null;
  adminNote?: string | null;
  refundAmount?: number | null;
};

interface Colors {
  bg: string; card: string; primary: string; text: string;
  muted: string; border: string; success: string; successBg: string;
  warn: string; warnBg: string; footerBg: string;
}

async function getSmtpConfig() {
  const cfg = await loadAppConfig();
  return {
    host:    cfg['smtpHost']   || '',
    port:    Number(cfg['smtpPort']   || 587),
    secure:  (cfg['smtpSecure'] || 'false') === 'true',
    user:    cfg['smtpUser']   || '',
    pass:    cfg['smtpPass']   || '',
    from:    cfg['smtpFrom']   || '',
    adminEmail: cfg['adminEmail'] || '',
    // Always absolute: every customer link in every template hangs off this.
    siteUrl: (cfg['siteUrl'] || '').replace(/\/+$/, '') || 'https://graveklar.no',
    businessName: cfg['businessName'] || 'Graveklar',
    businessTagline: cfg['businessTagline'] || '',
    serviceArea: cfg['serviceArea'] || '',
    contactEmail: cfg['contactEmail'] || '',
    accentColor: cfg['accentColor'] || '',
  };
}

function getColors(accent?: string): Colors {
  const primary = accent || '#1a5fb4';
  return {
    bg:       '#f4f4f5',
    card:     '#ffffff',
    primary,
    text:     '#1a1a1a',
    muted:    '#6b7280',
    border:   '#d4d4d8',
    success:  '#166534',
    successBg:'#f0fdf4',
    warn:     '#92400e',
    warnBg:   '#fffbeb',
    footerBg: '#e4e4e7',
  };
}

function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function getTransporter(smtp: Awaited<ReturnType<typeof getSmtpConfig>>) {
  if (!smtp.host || !smtp.user || !smtp.pass) return null;
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    // On the STARTTLS ports nodemailer upgrades opportunistically and falls
    // back to plaintext if the server doesn't offer TLS — silently sending
    // the SMTP password and customer PII in the clear. Refuse to downgrade,
    // except for a relay on the same box.
    requireTLS: !smtp.secure && !isLoopbackHost(smtp.host),
    auth: { user: smtp.user, pass: smtp.pass },
  });
}

/** Sender used when smtpFrom is blank: noreply@<site host>, never a placeholder domain. */
function fallbackFromAddress(smtp: Awaited<ReturnType<typeof getSmtpConfig>>): string {
  let host = 'graveklar.no';
  try {
    host = new URL(smtp.siteUrl).hostname.replace(/^www\./, '') || host;
  } catch { /* keep default */ }
  return `${smtp.businessName} <noreply@${host}>`;
}

// HTML-escape a raw user-supplied string so it can't smuggle markup into an
// admin or customer email body. Opt-in (apply at each call site that reads a
// customer field) rather than pushed into `detailRow`, because some callers
// pass intentional HTML — `<a href="mailto:...">` wrappers, the `discountKr`
// span, etc. — and double-escaping them would render the markup literally.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#?\w+;/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Deliver one message. Returns `true` when nodemailer accepted it and
 * `false` when there was nothing to send it with (SMTP not configured) —
 * a real delivery failure still throws, so a caller can tell "nothing was
 * configured" from "the server refused" from "it went out". The admin
 * test-email button reports on this (finding P-4); every other caller is
 * free to ignore it.
 */
async function send(smtp: Awaited<ReturnType<typeof getSmtpConfig>>, to: string, subject: string, html: string, attempt = 0, replyTo?: string): Promise<boolean> {
  const t = getTransporter(smtp);
  if (!t) {
    console.warn('SMTP not configured — skipping email to', to);
    return false;
  }
  const from = smtp.from || fallbackFromAddress(smtp);
  const text = htmlToText(html);
  try {
    await t.sendMail({ from, to, subject, html, text, ...(replyTo ? { replyTo } : {}) });
    return true;
  } catch (err: unknown) {
    const code = (err as { responseCode?: number }).responseCode;
    // 421 (service unavailable) and 451 (local error) are transient — worth
    // a retry. 550 (mailbox unavailable / rejected) is a *permanent*
    // refusal and was previously included by mistake; retrying it just
    // burns time before the same rejection.
    if (attempt < 3 && (code === 421 || code === 451)) {
      const delay = (attempt + 1) * 5000;
      console.warn(`Email to ${to} transient SMTP error ${code} (attempt ${attempt + 1}), retrying in ${delay / 1000}s…`);
      await new Promise(r => setTimeout(r, delay));
      return send(smtp, to, subject, html, attempt + 1, replyTo);
    }
    throw err;
  }
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('nb-NO', { day: 'numeric', month: 'long', year: 'numeric' });
}

function rentalTypeLabel(t: string): string {
  const labels: Record<string, string> = {
    day: '1 dag', weekend: 'Helg (fre–man)', week: '1 uke', custom: 'Tilpasset',
  };
  return labels[t] ?? t;
}

/* ─── HTML helpers (all take C for colors) ─── */

function layout(C: Colors, businessName: string, preheader: string, body: string, contactEmail: string, serviceArea?: string): string {
  // The preheader is plain text in both the places it lands, and four senders
  // build it from a customer-supplied field ("Ny booking fra ${name}"). The
  // hidden <span> is still real markup — an email client parses it and an
  // `<img src=x onerror=…>` fires its handler even while display:none — so
  // escape here, once, rather than at every call site (finding J-2). No caller
  // passes intentional markup in the preheader.
  const pre = escapeHtml(preheader);
  return `<!DOCTYPE html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${pre}</title>
</head>
<body style="margin:0;padding:0;background:${C.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<span style="display:none;max-height:0;overflow:hidden;">${pre}</span>

<table width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:32px 16px;">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">

      <!-- Header -->
      <tr><td style="background:${C.primary};border-radius:12px 12px 0 0;padding:28px 32px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td>
              <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">${businessName}</div>
              <div style="font-size:12px;color:rgba(255,255,255,0.65);margin-top:2px;letter-spacing:0.5px;text-transform:uppercase;">Utstyrsutleie</div>
            </td>
          </tr>
        </table>
      </td></tr>

      <!-- Card body -->
      <tr><td style="background:${C.card};padding:32px;">
        ${body}
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:${C.footerBg};border-radius:0 0 12px 12px;padding:20px 32px;">
        <p style="margin:0;font-size:12px;color:${C.muted};text-align:center;line-height:1.6;">
          Spørsmål? Kontakt oss på <a href="mailto:${contactEmail}" style="color:${C.primary};text-decoration:none;">${contactEmail}</a><br>
          ${businessName}${serviceArea ? ` &nbsp;·&nbsp; ${serviceArea}` : ''}
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function detailRow(C: Colors, label: string, value: string): string {
  return `<tr>
    <td style="padding:10px 16px;font-size:13px;color:${C.muted};width:140px;white-space:nowrap;vertical-align:top;">${label}</td>
    <td style="padding:10px 16px;font-size:14px;color:${C.text};font-weight:500;vertical-align:top;">${value}</td>
  </tr>`;
}

function detailTable(C: Colors, rows: string): string {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.border};border-radius:8px;border-collapse:separate;border-spacing:0;overflow:hidden;margin:20px 0;">
    ${rows}
  </table>`;
}

function ctaButton(C: Colors, href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;background:${C.primary};color:#ffffff;padding:13px 28px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:600;letter-spacing:-0.1px;">${label}</a>`;
}

function infoBox(C: Colors, content: string, variant: 'default' | 'success' | 'warn' = 'default'): string {
  const bg = variant === 'success' ? C.successBg : variant === 'warn' ? C.warnBg : C.bg;
  const border = variant === 'success' ? '#86efac' : variant === 'warn' ? '#fcd34d' : C.border;
  const color = variant === 'success' ? C.success : variant === 'warn' ? C.warn : C.text;
  return `<div style="background:${bg};border:1px solid ${border};border-radius:8px;padding:16px 20px;margin:20px 0;font-size:14px;color:${color};line-height:1.6;">${content}</div>`;
}

function heading(C: Colors, text: string): string {
  return `<h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:${C.text};letter-spacing:-0.5px;">${text}</h1>`;
}

function para(C: Colors, text: string, small = false): string {
  const size = small ? '13px' : '15px';
  return `<p style="margin:12px 0;font-size:${size};color:${small ? C.muted : C.text};line-height:1.65;">${text}</p>`;
}

function divider(C: Colors): string {
  return `<hr style="border:none;border-top:1px solid ${C.border};margin:24px 0;">`;
}

function priceRows(C: Colors, booking: Booking): string {
  const rows = [
    detailRow(C, 'Leiepris', `${booking.basePrice.toLocaleString('nb-NO')} kr`),
    ...(booking.extraHoursCost > 0 ? [detailRow(C, 'Forhåndsbestilte timer', `${booking.extraHoursCost.toLocaleString('nb-NO')} kr`)] : []),
    ...(booking.deliveryFee > 0 ? [detailRow(C, booking.selfPickup ? 'Selvhentingsgebyr' : 'Leveringsgebyr', `${booking.deliveryFee.toLocaleString('nb-NO')} kr`)] : []),
    ...(booking.discountKr && booking.discountKr > 0 ? [detailRow(C, booking.discountLabel || 'Rabatt', `<span style="color:${C.success}">-${booking.discountKr.toLocaleString('nb-NO')} kr</span>`)] : []),
    detailRow(C, 'Totalpris', `<strong style="font-size:16px;">${booking.totalPrice.toLocaleString('nb-NO')} kr</strong> <span style="font-size:12px;color:${C.muted}">inkl. mva</span>`),
  ];
  return rows.join('');
}

// End-date heuristic for display in the admin notification. Matches the
// same logic used by the admin "Next booking" banner.
function computeEndDate(booking: Pick<Booking, 'startDate' | 'rentalType' | 'customDays'>): Date {
  const start = booking.startDate instanceof Date ? new Date(booking.startDate) : new Date(booking.startDate);
  const add = (n: number) => { const d = new Date(start); d.setDate(d.getDate() + n); return d; };
  switch (booking.rentalType) {
    case 'day':     return add(1);
    case 'weekend': return add(3);
    case 'week':    return add(7);
    case 'custom':  return booking.customDays ? add(booking.customDays) : start;
    default:        return start;
  }
}

function formatDateTime(d: Date | string, time?: string | null): string {
  const asDate = d instanceof Date ? d : new Date(d);
  const date = formatDate(asDate);
  return time ? `${date} <span style="color:#888;">kl. ${time}</span>` : date;
}

/* ─── Email senders ─── */

export async function sendTestEmail(config: Record<string, string>, to: string): Promise<boolean> {
  const smtp = await getSmtpConfig();
  const C = getColors(smtp.accentColor);
  const body = `
    ${heading(C, 'Testmelding')}
    ${para(C, 'SMTP-konfigurasjonen fungerer! Denne meldingen ble sendt fra admin-panelet.')}
    ${infoBox(C, 'Hvis du ser denne e-posten betyr det at utsendingsoppsettet er riktig konfigurert.', 'success')}
  `;
  return send(smtp, to, `Testmelding fra ${smtp.businessName}`, layout(C, smtp.businessName, 'SMTP-konfigurasjon fungerer', body, smtp.contactEmail, smtp.serviceArea));
}

export interface ContactMessageInput {
  name: string;
  email: string;
  phone?: string;
  message: string;
}

/** Public contact-form submission → business inbox. Reply-To is the sender so
 *  the admin can answer directly. Returns false when no recipient/SMTP is
 *  configured so the caller can surface a useful error. */
export async function sendContactMessageEmail(input: ContactMessageInput): Promise<boolean> {
  const smtp = await getSmtpConfig();
  const to = smtp.adminEmail || smtp.contactEmail;
  if (!to || !getTransporter(smtp)) return false;
  const C = getColors(smtp.accentColor);
  const rows = [
    detailRow(C, 'Navn', escapeHtml(input.name)),
    detailRow(C, 'E-post', `<a href="mailto:${escapeHtml(input.email)}" style="color:${C.primary};text-decoration:none;">${escapeHtml(input.email)}</a>`),
    ...(input.phone ? [detailRow(C, 'Telefon', escapeHtml(input.phone))] : []),
  ].join('');
  const body = `
    ${heading(C, 'Ny henvendelse fra kontaktskjema')}
    ${detailTable(C, rows)}
    ${para(C, 'Melding:')}
    ${infoBox(C, escapeHtml(input.message).replace(/\n/g, '<br>'))}
    ${para(C, 'Svar direkte på denne e-posten for å kontakte avsenderen.', true)}
  `;
  await send(
    smtp,
    to,
    `Ny henvendelse: ${input.name}`,
    layout(C, smtp.businessName, `Henvendelse fra ${input.name}`, body, smtp.contactEmail, smtp.serviceArea),
    0,
    input.email,
  );
  return true;
}

type QuoteWithMachine = QuoteRequest & { machine?: Machine | null };

function quoteRentalLabel(q: QuoteWithMachine): string {
  const parts: string[] = [];
  if (q.rentalType) {
    parts.push(q.rentalType === 'custom' && q.customDays ? `Tilpasset (${q.customDays} dager)` : rentalTypeLabel(q.rentalType));
  }
  if (q.startDate) parts.push(`fra ${formatDate(q.startDate instanceof Date ? q.startDate : new Date(q.startDate))}`);
  return parts.length ? parts.join(' · ') : 'Ikke spesifisert';
}

export async function sendNewQuoteRequestAdminNotification(quote: QuoteWithMachine): Promise<void> {
  const smtp = await getSmtpConfig();
  if (!smtp.adminEmail) {
    console.warn('adminEmail not set — skipping quote admin notification');
    return;
  }
  const C = getColors(smtp.accentColor);
  const rows = [
    detailRow(C, 'Firma', `${escapeHtml(quote.company)} <span style="color:${C.muted}">(org.nr ${escapeHtml(quote.orgNumber)})</span>`),
    detailRow(C, 'Kontakt', escapeHtml(quote.contactName)),
    detailRow(C, 'E-post', `<a href="mailto:${escapeHtml(quote.email)}" style="color:${C.primary};text-decoration:none;">${escapeHtml(quote.email)}</a>`),
    detailRow(C, 'Telefon', escapeHtml(quote.phone)),
    ...(quote.machine ? [detailRow(C, 'Maskin', escapeHtml(quote.machine.name))] : []),
    detailRow(C, 'Periode', quoteRentalLabel(quote)),
    detailRow(C, 'M2-opplæring', quote.trainingConfirmed ? '<span style="color:#166534">Bekreftet</span>' : '<span style="color:#92400e">Ikke bekreftet</span>'),
    ...(quote.projectDescription ? [detailRow(C, 'Prosjekt', escapeHtml(quote.projectDescription))] : []),
  ].join('');

  const adminUrl = smtp.siteUrl ? `${smtp.siteUrl}/admin` : '';
  const body = `
    ${heading(C, 'Ny bedriftsforespørsel')}
    ${para(C, `<strong>${escapeHtml(quote.reference)}</strong> – ${escapeHtml(quote.company)} har bedt om et tilbud.`)}
    ${detailTable(C, rows)}
    ${adminUrl ? `<div style="text-align:center;margin:24px 0;">${ctaButton(C, adminUrl, 'Åpne i admin')}</div>` : ''}
    ${para(C, 'Gå inn i admin for å sende eller revidere et tilbud. Kalenderen blokkeres ikke før tilbudet er akseptert.', true)}
  `;
  await send(smtp, smtp.adminEmail, `Ny bedriftsforespørsel: ${quote.reference} – ${quote.company}`,
    layout(C, smtp.businessName, `Ny bedriftsforespørsel fra ${quote.company}`, body, smtp.contactEmail, smtp.serviceArea));
}

export async function sendQuoteRequestReceivedEmail(quote: QuoteWithMachine): Promise<void> {
  const smtp = await getSmtpConfig();
  const C = getColors(smtp.accentColor);
  const body = `
    ${heading(C, 'Forespørsel mottatt')}
    ${para(C, `Hei ${escapeHtml(quote.contactName)},`)}
    ${para(C, `Takk for forespørselen. Vi har registrert ønsket ditt om leie og kommer tilbake med et tilbud så snart som mulig.`)}
    ${detailTable(C, [
      detailRow(C, 'Referanse', escapeHtml(quote.reference)),
      detailRow(C, 'Firma', escapeHtml(quote.company)),
      ...(quote.machine ? [detailRow(C, 'Maskin', escapeHtml(quote.machine.name))] : []),
      detailRow(C, 'Periode', quoteRentalLabel(quote)),
    ].join(''))}
    ${infoBox(C, 'Tilbud og leieavtale for bedrift forutsetter at fører har gyldig dokumentert opplæring (M2) for maskinen. Bedriften er arbeidsgiver og ansvarlig for HMS ved bruk.', 'warn')}
    ${para(C, 'Har du spørsmål i mellomtiden, bare svar på denne e-posten.', true)}
  `;
  await send(smtp, quote.email, `Forespørsel mottatt – ${quote.reference}`,
    layout(C, smtp.businessName, 'Vi har mottatt forespørselen din', body, smtp.contactEmail, smtp.serviceArea));
}

export async function sendQuoteOfferEmail(quote: QuoteWithMachine): Promise<void> {
  const smtp = await getSmtpConfig();
  const C = getColors(smtp.accentColor);
  const acceptUrl = smtp.siteUrl && quote.acceptToken ? `${smtp.siteUrl}/tilbud/${quote.acceptToken}` : '';
  const amount = quote.offerAmount != null ? `${quote.offerAmount.toLocaleString('nb-NO')} kr` : 'Se beskrivelse';
  const validUntil = quote.offerValidUntil
    ? formatDate(quote.offerValidUntil instanceof Date ? quote.offerValidUntil : new Date(quote.offerValidUntil))
    : null;
  const paymentLabel = quote.paymentMode === 'invoice' ? 'Faktura' : quote.paymentMode === 'card' ? 'Kort (Stripe)' : null;

  const rows = [
    detailRow(C, 'Referanse', escapeHtml(quote.reference)),
    detailRow(C, 'Firma', escapeHtml(quote.company)),
    ...(quote.machine ? [detailRow(C, 'Maskin', escapeHtml(quote.machine.name))] : []),
    detailRow(C, 'Periode', quoteRentalLabel(quote)),
    detailRow(C, 'Pris', `<strong style="font-size:16px;">${amount}</strong> <span style="font-size:12px;color:${C.muted}">eks. mva</span>`),
    ...(paymentLabel ? [detailRow(C, 'Betaling', paymentLabel)] : []),
    ...(validUntil ? [detailRow(C, 'Gyldig til', validUntil)] : []),
  ].join('');

  const body = `
    ${heading(C, 'Tilbud på leie')}
    ${para(C, `Hei ${escapeHtml(quote.contactName)},`)}
    ${para(C, `Her er tilbudet på leie til ${escapeHtml(quote.company)}.`)}
    ${quote.offerMessage ? infoBox(C, escapeHtml(quote.offerMessage).replace(/\n/g, '<br>')) : ''}
    ${detailTable(C, rows)}
    ${acceptUrl ? `<div style="text-align:center;margin:24px 0;">${ctaButton(C, acceptUrl, 'Se og aksepter tilbudet')}</div>` : para(C, 'Svar på denne e-posten for å akseptere tilbudet.')}
    ${infoBox(C, 'Ved aksept gjelder bedriftsvilkårene våre, inkludert krav om at fører har gyldig dokumentert opplæring (M2). Bedriften er arbeidsgiver og ansvarlig for HMS ved bruk.', 'warn')}
    ${para(C, 'Har du spørsmål, bare svar på denne e-posten.', true)}
  `;
  await send(smtp, quote.email, `Tilbud på leie – ${quote.reference}`,
    layout(C, smtp.businessName, `Tilbud fra ${smtp.businessName}`, body, smtp.contactEmail, smtp.serviceArea));
}

export async function sendNewBookingAdminNotification(booking: Booking): Promise<boolean> {
  const smtp = await getSmtpConfig();
  const C = getColors(smtp.accentColor);
  if (!smtp.adminEmail) {
    console.warn('adminEmail not set — skipping admin notification');
    return false;
  }

  // Resolve the machine + pricing context so the admin sees a complete
  // picture without having to open the admin panel for every booking.
  const machine = booking.machineId
    ? await db.machine.findUnique({ where: { id: booking.machineId } }).catch(() => null)
    : null;
  const endDate = computeEndDate(booking);
  const equipmentLabel = machine
    ? `${machine.name}${machine.model ? ' ' + machine.model : ''}${machine.year ? ` (${machine.year})` : ''}`
    : 'Ikke valgt';
  // The same `preferredTime` field stores the customer's requested time slot
  // for both delivery + pickup — we surface it on both rows.
  const timeNote = booking.preferredTime?.trim() || null;

  const subtotalRow = booking.basePrice + (booking.extraHoursCost || 0) + (booking.deliveryFee || 0);
  // `totalPrice` is always the charged, MVA-inclusive amount, so the split is
  // "back out the MVA" — but at the CONFIGURED rate, not a hardcoded 25 %
  // (finding J-1). This is the one place an operator reconciles a booking
  // against the ledger; it has to agree with src/lib/mva.ts like everything
  // else does.
  const mvaRate = readMvaSettings(await loadConfigValues()).rate;
  const mvaIncluded = Math.round(splitMva(booking.totalPrice, { rate: mvaRate, storedInclMva: true }).mva);
  const subtotalEx = Math.round((booking.totalPrice - mvaIncluded));

  const adminBody = `
    ${heading(C, 'Ny booking')}
    <div style="display:inline-block;background:${C.bg};border:1px solid ${C.border};border-radius:6px;padding:4px 12px;font-size:13px;color:${C.muted};margin-bottom:4px;">${escapeHtml(booking.reference)}</div>
    ${para(C, `<strong>${escapeHtml(booking.name)}</strong> har booket og ${booking.fullyPaidAt ? 'betalt' : '<span style="color:' + C.warn + ';">ikke betalt ennå</span>'}.`)}

    <h3 style="margin:20px 0 8px;font-size:14px;color:${C.text};">Kunde</h3>
    ${detailTable(C, [
      detailRow(C, 'Navn', escapeHtml(booking.name)),
      detailRow(C, 'Telefon', `<a href="tel:${encodeURIComponent(booking.phone.replace(/\s/g, ''))}" style="color:${C.primary};text-decoration:none;">${escapeHtml(booking.phone)}</a>`),
      detailRow(C, 'E-post', `<a href="mailto:${encodeURIComponent(booking.email)}" style="color:${C.primary};text-decoration:none;">${escapeHtml(booking.email)}</a>`),
    ].join(''))}

    <h3 style="margin:20px 0 8px;font-size:14px;color:${C.text};">Utstyr og leieperiode</h3>
    ${detailTable(C, [
      detailRow(C, 'Utstyr', escapeHtml(equipmentLabel)),
      detailRow(C, 'Leietype', rentalTypeLabel(booking.rentalType)),
      detailRow(C, 'Fra', formatDateTime(booking.startDate, timeNote && !booking.selfPickup ? timeNote : null)),
      detailRow(C, 'Til', formatDateTime(endDate, timeNote && !booking.selfPickup ? timeNote : null)),
      ...(booking.customDays ? [detailRow(C, 'Antall dager', `${booking.customDays} dager`)] : []),
      detailRow(C, 'Inkluderte timer', `${booking.includedHours || 0} t`),
      ...(booking.extraHours > 0 ? [detailRow(C, 'Forhåndsbestilte ekstra timer', `${booking.extraHours} t`)] : []),
      detailRow(C, 'Totalt timer', `${booking.totalHours || 0} t`),
    ].join(''))}

    <h3 style="margin:20px 0 8px;font-size:14px;color:${C.text};">${booking.selfPickup ? 'Henting' : 'Levering'}</h3>
    ${detailTable(C, booking.selfPickup
      ? [
          detailRow(C, 'Metode', 'Selvhenting'),
          ...(timeNote ? [detailRow(C, 'Ønsket tid', escapeHtml(timeNote))] : []),
        ].join('')
      : [
          detailRow(C, 'Adresse', booking.deliveryAddress ? escapeHtml(booking.deliveryAddress) : '–'),
          detailRow(C, 'Distanse', `${(Number(booking.deliveryDistance) || 0).toFixed(1)} km`),
          ...(timeNote ? [detailRow(C, 'Ønsket tid (levering + henting)', escapeHtml(timeNote))] : []),
        ].join('')
    )}

    <h3 style="margin:20px 0 8px;font-size:14px;color:${C.text};">Pris</h3>
    ${detailTable(C, [
      detailRow(C, 'Grunnpris', `${booking.basePrice.toLocaleString('nb-NO')} kr`),
      ...(booking.extraHoursCost > 0 ? [detailRow(C, `Forhåndsbestilte timer (${booking.extraHours} t)`, `${booking.extraHoursCost.toLocaleString('nb-NO')} kr`)] : []),
      ...(booking.deliveryFee > 0 ? [detailRow(C, booking.selfPickup ? 'Selvhentingsgebyr' : `Levering (${(Number(booking.deliveryDistance) || 0).toFixed(1)} km)`, `${booking.deliveryFee.toLocaleString('nb-NO')} kr`)] : []),
      detailRow(C, 'Subtotal', `${subtotalRow.toLocaleString('nb-NO')} kr`),
      ...(booking.discountKr && booking.discountKr > 0 ? [detailRow(C, escapeHtml(booking.discountLabel || 'Rabatt'), `<span style="color:${C.success}">-${booking.discountKr.toLocaleString('nb-NO')} kr</span>`)] : []),
      detailRow(C, 'Sum eks. MVA', `${subtotalEx.toLocaleString('nb-NO')} kr`),
      detailRow(C, `MVA (${mvaRate.toLocaleString('nb-NO')} %)`, `${mvaIncluded.toLocaleString('nb-NO')} kr`),
      detailRow(C, 'Totalt inkl. MVA', `<strong style="font-size:16px;">${booking.totalPrice.toLocaleString('nb-NO')} kr</strong>`),
    ].join(''))}

    ${booking.notes ? `<h3 style="margin:20px 0 8px;font-size:14px;color:${C.text};">Notater fra kunden</h3>${detailTable(C, detailRow(C, 'Kommentar', escapeHtml(booking.notes)))}` : ''}

    <div style="margin-top:24px;">
      ${ctaButton(C, `${smtp.siteUrl}/admin`, 'Åpne admin-panelet')}
    </div>
  `;

  await new Promise(r => setTimeout(r, 2000));
  try {
    return await send(smtp, smtp.adminEmail, `Ny booking: ${booking.reference} – ${booking.name}`,
      layout(C, smtp.businessName, `Ny booking fra ${booking.name}`, adminBody, smtp.contactEmail, smtp.serviceArea));
  } catch (err) {
    // Swallowed on purpose: a booking must not fail because the operator's
    // mail server is down. The `false` is what the admin test-email button
    // reports on (finding P-4).
    console.error('Email send to admin failed:', err);
    return false;
  }
}

export async function sendBookingStatusEmail(
  booking: BookingWithExtras,
  status: string,
  extras?: { reason?: string; repeatCode?: string; repeatPercent?: number; repeatExpiresAt?: Date }
): Promise<boolean> {
  const smtp = await getSmtpConfig();
  const C = getColors(smtp.accentColor);
  const { contactEmail, businessName, siteUrl } = smtp;

  if (status === 'confirmed') {
    const cancelToken = crypto.randomUUID();
    const cancelTokenExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    // Wrapped in try/catch so the admin "send sample email" testing flow
    // doesn't crash when the booking row doesn't actually exist in DB.
    try {
      await db.booking.update({
        where: { id: booking.id },
        data: { cancelToken, cancelTokenExpiry },
      });
    } catch (err) {
      // If the booking isn't real (sample test send) we still want the
      // email to render — just use the generated token in the URL without
      // persisting it.
      console.warn('confirmed email: skipped DB update for sample/missing booking', (err as Error).message);
    }
    const cancelUrl = `${siteUrl}/booking/cancel?token=${cancelToken}`;

    const body = `
      ${infoBox(C, '✓ &nbsp;Din booking er bekreftet og betalt!', 'success')}
      ${heading(C, `Hei, ${escapeHtml(booking.name)}!`)}
      ${para(C, 'Vi gleder oss til å hjelpe deg. Her er en oversikt over bookingen din:')}

      ${detailTable(C, [
        detailRow(C, 'Referanse', `<strong>${escapeHtml(booking.reference)}</strong>`),
        detailRow(C, 'Type leie', rentalTypeLabel(booking.rentalType)),
        detailRow(C, 'Startdato', formatDate(booking.startDate)),
        ...(booking.customDays ? [detailRow(C, 'Antall dager', `${booking.customDays} dager`)] : []),
        detailRow(C, 'Levering', booking.selfPickup ? 'Selvhenting' : (booking.deliveryAddress ? escapeHtml(booking.deliveryAddress) : '–')),
        ...(booking.paymentMethod
          ? [detailRow(C, 'Betalt med', booking.paymentMethod === 'vipps' ? 'Vipps' : booking.paymentMethod === 'card' ? 'Kort' : escapeHtml(booking.paymentMethod))]
          : []),
      ].join(''))}

      ${detailTable(C, priceRows(C, booking))}

      ${divider(C)}
      ${para(C, `Har du spørsmål eller trenger du å gjøre endringer? Ta kontakt med oss på <a href="mailto:${contactEmail}" style="color:${C.primary};text-decoration:none;">${contactEmail}</a>.`)}
      ${para(C, `Trenger du å avbestille? <a href="${cancelUrl}" style="color:${C.muted};font-size:13px;">Klikk her</a> (lenken er gyldig i 30 dager).`, true)}
    `;

    return send(smtp, booking.email, `Booking bekreftet – ${booking.reference}`,
      layout(C, businessName, `Booking ${booking.reference} er bekreftet`, body, contactEmail, smtp.serviceArea));
  }

  if (status === 'cancelled') {
    const fee = booking.cancellationFee ?? 0;
    const refund = booking.refundAmount ?? 0;

    let feeBlock: string;
    if (fee > 0 && refund > 0) {
      feeBlock = infoBox(C, `<strong>Avbestillingsgebyr: ${fee.toLocaleString('nb-NO')} kr</strong><br>Refusjon på <strong>${refund.toLocaleString('nb-NO')} kr</strong> er sendt til din betalingsmetode. Det kan ta 5–10 virkedager.`, 'warn');
    } else if (fee > 0) {
      feeBlock = infoBox(C, `<strong>Avbestillingsgebyr: ${fee.toLocaleString('nb-NO')} kr</strong><br>Ingen refusjon – hele beløpet beholdes som gebyr.`, 'warn');
    } else if (refund > 0) {
      feeBlock = infoBox(C, `Ingen avbestillingsgebyr. Refusjon på <strong>${refund.toLocaleString('nb-NO')} kr</strong> er sendt til din betalingsmetode. Det kan ta 5–10 virkedager.`, 'success');
    } else {
      feeBlock = infoBox(C, 'Ingen avbestillingsgebyr – du belastes ingenting.', 'success');
    }

    // If we issued a discount code as goodwill compensation, surface it
    // prominently in the cancellation email so the customer feels welcomed
    // back rather than dismissed.
    const codeBlock = extras?.repeatCode
      ? `
        <div style="margin:24px 0;padding:16px;background:${C.successBg};border:1px solid ${C.success};border-radius:8px;">
          <div style="font-size:13px;color:${C.muted};margin-bottom:6px;">Som takk for tålmodigheten</div>
          <div style="font-size:18px;font-weight:bold;color:${C.text};margin-bottom:4px;">
            ${extras.repeatPercent ?? 10} % rabatt på neste booking
          </div>
          <div style="font-family:monospace;font-size:16px;letter-spacing:2px;background:${C.bg};border:1px dashed ${C.border};border-radius:4px;padding:8px 12px;display:inline-block;margin-top:8px;">
            ${extras.repeatCode}
          </div>
          <div style="font-size:12px;color:${C.muted};margin-top:8px;">
            ${extras.repeatExpiresAt ? `Gyldig til ${formatDate(extras.repeatExpiresAt)} · ` : ''}Engangsbruk, knyttet til denne e-postadressen.
          </div>
        </div>
      `
      : '';

    const reasonBlock = extras?.reason
      ? `${para(C, `<strong>Angitt årsak:</strong> ${escapeHtml(extras.reason)}`, true)}`
      : '';

    const body = `
      ${heading(C, `Hei, ${escapeHtml(booking.name)}`)}
      ${para(C, `Bookingen din (referanse: <strong>${escapeHtml(booking.reference)}</strong>) er nå kansellert.`)}
      ${reasonBlock}
      ${feeBlock}
      ${codeBlock}
      ${para(C, extras?.repeatCode
        ? 'Vi håper å se deg tilbake snart. Bruk koden over neste gang du booker.'
        : 'Ønsker du å booke på nytt på en annen dato er du hjertelig velkommen til å prøve igjen.'
      )}
      <div style="margin-top:24px;">
        ${ctaButton(C, `mailto:${contactEmail}`, 'Kontakt oss')}
      </div>
    `;

    // The customer copy is the one the caller is told about; the admin copy
    // below is fire-and-forget by design.
    const sent = await send(smtp, booking.email, `Booking kansellert – ${booking.reference}`,
      layout(C, businessName, `Booking ${booking.reference} er kansellert`, body, contactEmail, smtp.serviceArea));

    if (smtp.adminEmail) {
      const feeText = fee > 0
        ? `Avbestillingsgebyr: ${fee.toLocaleString('nb-NO')} kr`
        : 'Ingen avbestillingsgebyr';
      const refundText = refund > 0
        ? `Refundert: ${refund.toLocaleString('nb-NO')} kr`
        : 'Ingen refusjon';

      const adminBody = `
        ${infoBox(C, `<strong>${escapeHtml(booking.name)}</strong> har avbestilt booking <strong>${escapeHtml(booking.reference)}</strong>.`, 'warn')}
        ${heading(C, 'Booking avbestilt')}

        ${detailTable(C, [
          detailRow(C, 'Referanse', `<strong>${escapeHtml(booking.reference)}</strong>`),
          detailRow(C, 'Kunde', `${escapeHtml(booking.name)} · <a href="mailto:${encodeURIComponent(booking.email)}" style="color:${C.primary};text-decoration:none;">${escapeHtml(booking.email)}</a>`),
          detailRow(C, 'Type leie', rentalTypeLabel(booking.rentalType)),
          detailRow(C, 'Startdato', formatDate(booking.startDate)),
          detailRow(C, 'Gebyr', feeText),
          detailRow(C, 'Refusjon', refundText),
        ].join(''))}

        <div style="margin-top:24px;">
          ${ctaButton(C, `${siteUrl}/admin`, 'Åpne admin-panelet')}
        </div>
      `;

      await new Promise(r => setTimeout(r, 2000));
      send(smtp, smtp.adminEmail, `Booking avbestilt: ${booking.reference} – ${booking.name}`,
        layout(C, businessName, `${booking.name} har avbestilt ${booking.reference}`, adminBody, contactEmail, smtp.serviceArea)
      ).catch(err => console.error('Cancel admin notification error:', err));
    }

    return sent;
  }

  // No template for this status — nothing was sent.
  return false;
}

export async function sendRepeatDiscountEmail(
  booking: Booking,
  code: string,
  percent: number,
  expiresAt: Date | null,
): Promise<void> {
  const smtp = await getSmtpConfig();
  const C = getColors(smtp.accentColor);
  const { contactEmail, businessName, siteUrl } = smtp;
  const expiresLine = expiresAt
    ? `Koden gjelder til <strong>${formatDate(expiresAt)}</strong>.`
    : 'Koden har ingen utløpsdato.';

  const body = `
    ${heading(C, `Takk for at du leide hos oss, ${escapeHtml(booking.name)}!`)}
    ${para(C, `Som returkunde får du ${percent}% rabatt på din neste booking. Bruk koden under når du booker neste gang – den er knyttet til din e-postadresse og kan bare brukes én gang.`)}

    <div style="margin:20px 0;padding:18px;border:2px dashed ${C.primary};border-radius:10px;text-align:center;background:${C.bg};">
      <div style="font-size:11px;color:${C.muted};text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Din rabattkode</div>
      <div style="font-size:26px;font-weight:700;font-family:'SF Mono',Menlo,Consolas,monospace;letter-spacing:2px;color:${C.primary};">${code}</div>
      <div style="font-size:12px;color:${C.muted};margin-top:10px;">${percent}% rabatt · ${expiresLine}</div>
    </div>

    ${para(C, `Klar for neste oppdrag? <a href="${siteUrl}" style="color:${C.primary};text-decoration:none;font-weight:600;">Book ny leie</a>`)}
    ${para(C, `Spørsmål? Ta kontakt på <a href="mailto:${contactEmail}" style="color:${C.primary};text-decoration:none;">${contactEmail}</a>.`)}
  `;

  await send(smtp, booking.email, `Takk for leien – ${percent}% rabatt på neste booking`,
    layout(C, businessName, `${percent}% rabatt på neste booking`, body, contactEmail, smtp.serviceArea));
}

/** Post-rental review request. Links to the tokenized public submit page. */
export async function sendReviewRequestEmail(booking: Booking, token: string): Promise<void> {
  const smtp = await getSmtpConfig();
  const C = getColors(smtp.accentColor);
  const { contactEmail, businessName, siteUrl } = smtp;
  const link = `${siteUrl}/omtale/${token}`;

  const stars = `<div style="font-size:30px;letter-spacing:4px;color:#f59e0b;text-align:center;margin:8px 0;">★★★★★</div>`;
  const body = `
    ${heading(C, `Hvordan var leien, ${escapeHtml(firstNameOf(booking.name))}?`)}
    ${para(C, `Takk for at du leide hos ${escapeHtml(businessName)}! Vi setter stor pris på om du tar 30 sekunder på å gi oss en vurdering – det hjelper andre kunder og oss med å bli bedre.`)}
    ${stars}
    <div style="text-align:center;margin:24px 0;">${ctaButton(C, link, 'Gi din vurdering')}</div>
    ${para(C, `Hvis knappen ikke virker, lim inn denne lenken i nettleseren:<br><a href="${link}" style="color:${C.primary};word-break:break-all;">${link}</a>`, true)}
    ${para(C, `Spørsmål? Ta kontakt på <a href="mailto:${contactEmail}" style="color:${C.primary};text-decoration:none;">${contactEmail}</a>.`, true)}
  `;

  await send(smtp, booking.email, `Gi en vurdering av leien hos ${businessName}`,
    layout(C, businessName, 'Del din opplevelse', body, contactEmail, smtp.serviceArea));
}

function firstNameOf(full: string): string {
  return (full || '').trim().split(/\s+/)[0] || '';
}

/** Sent when a survey respondent leaves their email + consents to the launch
 *  list. Hands them the shared campaign discount code. Not tied to a booking. */
export async function sendSurveyDiscountEmail(
  to: string,
  code: string,
  percent: number,
): Promise<void> {
  const smtp = await getSmtpConfig();
  const C = getColors(smtp.accentColor);
  const { contactEmail, businessName } = smtp;

  const body = `
    ${heading(C, 'Takk for at du svarte!')}
    ${para(C, `Du står nå på lista vår og får beskjed så snart vi åpner for booking. Som takk får du <strong>${percent}% rabatt</strong> på din første leie – bruk koden under i kassen.`)}

    <div style="margin:20px 0;padding:18px;border:2px dashed ${C.primary};border-radius:10px;text-align:center;background:${C.bg};">
      <div style="font-size:11px;color:${C.muted};text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Din rabattkode</div>
      <div style="font-size:26px;font-weight:700;font-family:'SF Mono',Menlo,Consolas,monospace;letter-spacing:2px;color:${C.primary};">${escapeHtml(code)}</div>
      <div style="font-size:12px;color:${C.muted};margin-top:10px;">${percent}% rabatt ved lansering</div>
    </div>

    ${para(C, 'Du kan når som helst melde deg av ved å svare på denne e-posten.')}
    ${para(C, `Spørsmål? Ta kontakt på <a href="mailto:${contactEmail}" style="color:${C.primary};text-decoration:none;">${contactEmail}</a>.`)}
  `;

  await send(smtp, to, `Velkommen – ${percent}% rabatt ved lansering`,
    layout(C, businessName, `${percent}% rabatt ved lansering`, body, contactEmail, smtp.serviceArea));
}

export async function sendPaymentRetryEmail(
  booking: Booking,
  retryUrl: string,
  minutesValid: number = 30,
): Promise<boolean> {
  const smtp = await getSmtpConfig();
  const C = getColors(smtp.accentColor);
  const { contactEmail, businessName } = smtp;

  const body = `
    ${infoBox(C, `Du har <strong>${minutesValid} minutter</strong> på deg til å fullføre betalingen, ellers blir bookingen automatisk kansellert.`, 'warn')}
    ${heading(C, `Hei, ${escapeHtml(booking.name)}`)}
    ${para(C, 'Vi mottok ikke betalingen for bookingen din. <strong>Fullfør betalingen for å bekrefte bookingen.</strong> Klikk lenken nedenfor for å prøve igjen.')}

    ${detailTable(C, [
      detailRow(C, 'Referanse', `<strong>${escapeHtml(booking.reference)}</strong>`),
      detailRow(C, 'Type leie', rentalTypeLabel(booking.rentalType)),
      detailRow(C, 'Startdato', formatDate(booking.startDate)),
      ...(booking.customDays ? [detailRow(C, 'Antall dager', `${booking.customDays} dager`)] : []),
    ].join(''))}

    ${detailTable(C, priceRows(C, booking))}

    <div style="margin-top:24px;">
      ${ctaButton(C, retryUrl, 'Fullfør betalingen for å bekrefte bookingen')}
    </div>

    ${para(C, `Spørsmål? Ta kontakt på <a href="mailto:${contactEmail}" style="color:${C.primary};text-decoration:none;">${contactEmail}</a>.`)}
  `;

  return send(smtp, booking.email, `Fullfør betalingen for å bekrefte bookingen – ${booking.reference}`,
    layout(C, businessName, 'Fullfør betalingen for å bekrefte bookingen', body, contactEmail, smtp.serviceArea));
}

/** Sent when a pending booking is auto-cancelled by the cleanup job because
 *  its payment window lapsed. Lets the customer know the booking is gone and
 *  invites them to start over — without it, they get no signal at all. */
export async function sendBookingExpiredEmail(booking: Booking): Promise<void> {
  const smtp = await getSmtpConfig();
  const C = getColors(smtp.accentColor);
  const { contactEmail, businessName, siteUrl } = smtp;

  const body = `
    ${infoBox(C, 'Bookingen din ble automatisk kansellert fordi betalingen ikke ble fullført i tide.', 'warn')}
    ${heading(C, `Hei, ${escapeHtml(booking.name)}`)}
    ${para(C, `Bookingen din (referanse: <strong>${escapeHtml(booking.reference)}</strong>) er ikke lenger gyldig. Hvis du fortsatt ønsker å leie utstyret, må du starte på nytt fra forsiden.`)}

    ${detailTable(C, [
      detailRow(C, 'Referanse', `<strong>${escapeHtml(booking.reference)}</strong>`),
      detailRow(C, 'Type leie', rentalTypeLabel(booking.rentalType)),
      detailRow(C, 'Startdato', formatDate(booking.startDate)),
      ...(booking.customDays ? [detailRow(C, 'Antall dager', `${booking.customDays} dager`)] : []),
    ].join(''))}

    ${siteUrl ? `<div style="margin-top:24px;">${ctaButton(C, siteUrl, 'Book på nytt')}</div>` : ''}

    ${para(C, `Spørsmål? Ta kontakt på <a href="mailto:${contactEmail}" style="color:${C.primary};text-decoration:none;">${contactEmail}</a>.`)}
  `;

  await send(smtp, booking.email, `Bookingen din utløp – ${booking.reference}`,
    layout(C, businessName, 'Bookingen din utløp', body, contactEmail, smtp.serviceArea));
}

export async function sendBookingReminderEmail(booking: Booking): Promise<boolean> {
  const smtp = await getSmtpConfig();
  const C = getColors(smtp.accentColor);
  const { contactEmail, businessName, siteUrl } = smtp;
  const scheduleLabel = (() => {
    const labels: Record<string, string> = {
      day: 'Døgn', weekend: 'Helg', week: 'Uke', custom: 'Tilpasset',
    };
    return labels[booking.rentalType] ?? booking.rentalType;
  })();

  const body = `
    ${heading(C, `Påminnelse: Bookingen din starter i morgen!`)}
    ${para(C, `Hei, ${escapeHtml(booking.name)}! Vi minner om at bookingen din starter i morgen.`)}

    ${detailTable(C, [
      detailRow(C, 'Referanse', `<strong>${escapeHtml(booking.reference)}</strong>`),
      detailRow(C, 'Type leie', scheduleLabel),
      detailRow(C, 'Startdato', formatDate(booking.startDate)),
      ...(booking.customDays ? [detailRow(C, 'Antall dager', `${booking.customDays} dager`)] : []),
      detailRow(C, 'Levering', booking.selfPickup ? 'Selvhenting' : (booking.deliveryAddress ? escapeHtml(booking.deliveryAddress) : '–')),
    ].join(''))}

    ${detailTable(C, priceRows(C, booking))}

    ${para(C, `Spørsmål eller endringer? Ta kontakt med oss på <a href="mailto:${contactEmail}" style="color:${C.primary};text-decoration:none;">${contactEmail}</a>.`)}
  `;

  const sent = await send(smtp, booking.email, `Påminnelse: Booking ${booking.reference} starter i morgen`,
    layout(C, businessName, `Bookingen din starter i morgen`, body, contactEmail, smtp.serviceArea));

  // Also notify admin so the operator gets a heads-up the day before to
  // start klargjøring. Matches the new "checklist phase per day" workflow.
  if (smtp.adminEmail) {
    const adminBody = `
      ${heading(C, 'Booking i morgen')}
      ${para(C, `<strong>${escapeHtml(booking.name)}</strong> sin booking starter i morgen. Tid for klargjøring i dag.`)}
      ${detailTable(C, [
        detailRow(C, 'Referanse', `<strong>${escapeHtml(booking.reference)}</strong>`),
        detailRow(C, 'Kunde', `${escapeHtml(booking.name)} · <a href="tel:${encodeURIComponent(booking.phone.replace(/\s/g, ''))}" style="color:${C.primary};text-decoration:none;">${escapeHtml(booking.phone)}</a>`),
        detailRow(C, 'Type leie', scheduleLabel),
        detailRow(C, 'Startdato', formatDate(booking.startDate)),
        detailRow(C, 'Levering', booking.selfPickup ? 'Selvhenting' : (booking.deliveryAddress ? escapeHtml(booking.deliveryAddress) : '–')),
        ...(booking.preferredTime ? [detailRow(C, 'Ønsket tid', escapeHtml(booking.preferredTime))] : []),
      ].join(''))}
      <div style="margin-top:24px;">
        ${ctaButton(C, `${siteUrl}/admin`, 'Åpne admin-panelet')}
      </div>
    `;
    try {
      await send(smtp, smtp.adminEmail, `Booking i morgen: ${booking.reference} – ${booking.name}`,
        layout(C, businessName, 'Booking i morgen', adminBody, contactEmail, smtp.serviceArea));
    } catch (err) {
      console.error('Admin reminder send failed:', err);
    }
  }

  return sent;
}

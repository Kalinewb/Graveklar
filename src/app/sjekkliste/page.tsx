import SjekklisteClient from './SjekklisteClient';

export const metadata = {
  title: 'Utstyrsjekk',
  description: 'Fyll ut utstyrsjekk for din aktive leie',
  // Private, phone-gated page reached from a QR code — never index it.
  robots: { index: false, follow: false },
};

export default function SjekklistePage() {
  return <SjekklisteClient />;
}

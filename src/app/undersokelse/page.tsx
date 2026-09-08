import type { Metadata } from 'next';
import { SurveyScreen } from '@/components/survey/SurveyScreen';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Behovsundersøkelse · Graveklar',
  description: 'Hjelp oss å forme tilbudet. Tar ca. 2 minutter.',
  robots: { index: false, follow: false },
};

export default function UndersokelsePage() {
  return <SurveyScreen />;
}

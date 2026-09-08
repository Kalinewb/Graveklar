import { NextResponse } from 'next/server';
import { loadActiveSurveyQuestions } from '@/lib/survey-service';

export const dynamic = 'force-dynamic';

// Public, read-only. Returns the active survey question set (seeded from
// survey-defaults on first call). The customer wizard renders from this so
// admins can edit questions with no deploy.
export async function GET() {
  try {
    const questions = await loadActiveSurveyQuestions();
    return NextResponse.json({ questions });
  } catch (err) {
    console.error('[api/survey/questions] failed:', err);
    return NextResponse.json({ questions: [] }, { status: 500 });
  }
}

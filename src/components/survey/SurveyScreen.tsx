import { loadActiveSurveyQuestions } from '@/lib/survey-service';
import { loadAppConfig } from '@/lib/app-config';
import { SurveyExperience } from '@/components/survey/SurveyExperience';

// Server component shared by the /undersokelse route and the survey-mode gate
// on the homepage. Loads the active questions + the public lead settings and
// hands them to the client wizard.
export async function SurveyScreen() {
  const [questions, appConfig] = await Promise.all([
    loadActiveSurveyQuestions(),
    loadAppConfig(),
  ]);

  return (
    <SurveyExperience
      questions={questions}
      leadPercent={Number(appConfig['surveyLeadDiscountPercent'] || '15') || 15}
      businessName={appConfig['businessName'] || 'Graveklar'}
    />
  );
}

'use client';

import Link from 'next/link';
import { ExternalLink, FlaskConical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function TestChecklistPanel() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <FlaskConical className="w-4 h-4" />
          Sjekkliste-sandbox
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Test operatør- og kunde-QR side om side med samme regler som produksjon: utlevering må fullføres før QR,
          faser i rekkefølge, retur/daglig timing. Ingen ekte booking.
        </p>
        <Button size="sm" asChild className="gap-1.5">
          <Link href="/admin/checklist/sandbox">
            <ExternalLink className="w-4 h-4" />
            Åpne sandbox
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

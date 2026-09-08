'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { QrCode, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Props {
  siteUrl: string;
  businessName: string;
}

export function ChecklistQrPanel({ siteUrl, businessName }: Props) {
  const [qrDataUrl, setQrDataUrl] = useState('');
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const kioskUrl = `${(siteUrl || origin).replace(/\/+$/, '')}/sjekkliste`;

  useEffect(() => {
    QRCode.toDataURL(kioskUrl, { width: 220, margin: 2 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(''));
  }, [kioskUrl]);

  const download = () => {
    if (!qrDataUrl) return;
    const a = document.createElement('a');
    a.href = qrDataUrl;
    a.download = `${businessName.replace(/\s+/g, '-').toLowerCase()}-sjekkliste-qr.png`;
    a.click();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <QrCode className="w-4 h-4" />
          QR-kode for leietakere
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col sm:flex-row gap-4 items-start">
        {qrDataUrl ? (
          <img src={qrDataUrl} alt="QR-kode til utstyrsjekk" className="rounded-lg border w-[220px] h-[220px]" />
        ) : (
          <div className="w-[220px] h-[220px] rounded-lg border bg-muted animate-pulse" />
        )}
        <div className="space-y-3 text-sm flex-1">
          <p className="text-muted-foreground">
            Skriv ut eller heng opp denne QR-koden på utstyret. Leietakere skanner, skriver inn telefonnummeret sitt,
            og fyller ut sjekklisten for sin aktive booking.
          </p>
          <code className="block text-xs bg-muted px-2 py-1.5 rounded break-all">{kioskUrl}</code>
          <Button variant="outline" size="sm" onClick={download} disabled={!qrDataUrl} className="gap-1.5">
            <Download className="w-4 h-4" />
            Last ned QR
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

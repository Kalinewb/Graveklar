import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const sections = await db.termsSection.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  return NextResponse.json({ sections });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const section = await db.termsSection.create({
      data: {
        title: body.title?.trim() || '',
        content: body.content?.trim() || '',
        sortOrder: body.sortOrder ?? 0,
        isActive: body.isActive !== false,
        audience: body.audience === 'business' ? 'business' : 'consumer',
      },
    });
    return NextResponse.json({ success: true, section }, { status: 201 });
  } catch (err) {
    console.error('admin/terms error:', err);
    return NextResponse.json({ error: 'Kunne ikke opprette vilkårsseksjon' }, { status: 500 });
  }
}

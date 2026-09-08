'use client';

import type React from 'react';
import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Moon, Sun, SunMoon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// Simple light/dark toggle for the customer-facing header.
export function ThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <Button variant="ghost" size="icon" aria-label="Bytt fargetema" disabled>
        <SunMoon className="w-4 h-4" />
      </Button>
    );
  }

  const isDark = resolvedTheme === 'dark';

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={isDark ? 'Bytt til lyst tema' : 'Bytt til mørkt tema'}
      title={isDark ? 'Bytt til lyst tema' : 'Bytt til mørkt tema'}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
    >
      {isDark ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
    </Button>
  );
}

// 3-way Lys/Mørk/System selector for the admin header.
export function AdminThemeMenu() {
  const [mounted, setMounted] = useState(false);
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <span
        className="inline-flex items-center justify-center w-9 h-9 rounded-md border border-border text-muted-foreground"
        aria-hidden
      >
        <SunMoon className="w-4 h-4" />
      </span>
    );
  }

  const options: { value: string; label: string; icon: React.ReactNode }[] = [
    { value: 'light', label: 'Lys', icon: <Sun className="w-4 h-4" /> },
    { value: 'dark', label: 'Mørk', icon: <Moon className="w-4 h-4" /> },
    { value: 'system', label: 'System', icon: <SunMoon className="w-4 h-4" /> },
  ];
  const current = options.find((o) => o.value === theme) ?? options[2];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Fargetema"
          aria-label="Fargetema"
          className="inline-flex items-center justify-center w-9 h-9 rounded-md border border-border hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
        >
          {current.icon}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {options.map((opt) => (
          <DropdownMenuItem key={opt.value} onClick={() => setTheme(opt.value)}>
            {opt.icon}
            {opt.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

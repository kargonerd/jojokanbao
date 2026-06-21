import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import {
  DEFAULT_MOCK_VARIANT,
  MOCK_VARIANTS,
  getMockVariantDefinition,
  resolveMockVariant,
  type MockVariantDefinition,
  type MockVariantId
} from './variants';

type MockVariantContextValue = {
  variant: MockVariantId;
  variantDefinition: MockVariantDefinition;
  variants: MockVariantDefinition[];
  setVariant: (variant: MockVariantId) => void;
  withVariant: (path: string) => string;
};

const MockVariantContext = createContext<MockVariantContextValue | null>(null);

const FALLBACK_VARIANT = DEFAULT_MOCK_VARIANT;
const FALLBACK_CONTEXT: MockVariantContextValue = {
  variant: FALLBACK_VARIANT,
  variantDefinition: getMockVariantDefinition(FALLBACK_VARIANT),
  variants: MOCK_VARIANTS,
  setVariant: () => {},
  withVariant: (path) => appendVariant(path, FALLBACK_VARIANT)
};

function appendVariant(path: string, variant: MockVariantId) {
  if (!path) {
    return `/?variant=${variant}`;
  }

  const [pathname, hashFragment = ''] = path.split('#');
  const separator = pathname.includes('?') ? '&' : '?';
  const nextPath = `${pathname}${separator}variant=${variant}`;
  return hashFragment ? `${nextPath}#${hashFragment}` : nextPath;
}

export function MockVariantProvider({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const electronVariantLocked = typeof window !== 'undefined' && Boolean(window.jojoPress);
  const variant = electronVariantLocked ? DEFAULT_MOCK_VARIANT : resolveMockVariant(new URLSearchParams(location.search).get('variant'));

  useEffect(() => {
    document.body.dataset.mockVariant = variant;
  }, [variant]);

  const value = useMemo<MockVariantContextValue>(
    () => ({
      variant,
      variantDefinition: getMockVariantDefinition(variant),
      variants: MOCK_VARIANTS,
      setVariant: (nextVariant) => {
        if (electronVariantLocked) {
          return;
        }

        const searchParams = new URLSearchParams(location.search);
        searchParams.set('variant', nextVariant);
        const search = searchParams.toString();
        void navigate(`${location.pathname}${search ? `?${search}` : ''}`, { replace: true });
      },
      withVariant: (path) => appendVariant(path, variant)
    }),
    [electronVariantLocked, location.pathname, location.search, navigate, variant]
  );

  return <MockVariantContext.Provider value={value}>{children}</MockVariantContext.Provider>;
}

export function useMockVariant() {
  const context = useContext(MockVariantContext);
  return context ?? FALLBACK_CONTEXT;
}

export function getVariantHref(path: string, variant: MockVariantId = DEFAULT_MOCK_VARIANT) {
  return appendVariant(path, variant);
}

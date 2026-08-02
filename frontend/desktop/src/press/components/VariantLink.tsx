import { Link, type LinkProps } from 'react-router-dom';

import { useMockVariant } from '../mock/variant-context';

type VariantLinkProps = Omit<LinkProps, 'to'> & {
  to: string;
};

export function VariantLink({ to, ...props }: VariantLinkProps) {
  const { withVariant } = useMockVariant();
  return <Link {...props} to={withVariant(to)} />;
}

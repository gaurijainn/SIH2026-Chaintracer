import { Search } from 'lucide-react';
import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/** Search field with a leading icon. Pass `label` for the accessible name (the placeholder is not a label). */
export const SearchInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { label: string; wrapperClassName?: string }>(
  ({ label, className, wrapperClassName, ...props }, ref) => (
    <div className={cn('relative', wrapperClassName)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <input
        ref={ref}
        type="search"
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        className={cn('h-9 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm placeholder:text-muted-foreground', className)}
        {...props}
      />
    </div>
  ),
);
SearchInput.displayName = 'SearchInput';

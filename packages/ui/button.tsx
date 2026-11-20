import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
const variants = cva("button", {
  variants: {
    variant: { default: "primary", secondary: "secondary", ghost: "ghost" },
  },
  defaultVariants: { variant: "default" },
});
export function Button({
  className,
  variant,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof variants>) {
  return <button className={variants({ variant, className })} {...props} />;
}

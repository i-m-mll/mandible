declare module "@profoundlogic/hogan" {
  export type Context = Record<string, unknown>;
  export type Partials = Record<string, string | Template>;
  export type Template = {
    render: (context?: Context, partials?: Partials, indent?: string) => string;
  };

  export const compile: (template: string) => Template;
}

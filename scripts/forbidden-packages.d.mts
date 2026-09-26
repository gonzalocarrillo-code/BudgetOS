export interface ForbiddenPackage {
  name: string;
  regex: RegExp;
  glob: string;
}
export declare const FORBIDDEN_PACKAGES: ForbiddenPackage[];
export declare function forbiddenMatch(name: string): ForbiddenPackage | null;

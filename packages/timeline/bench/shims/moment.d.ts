export type MomentInput = string | number | Date;
export type MomentFormatSpecification = string | string[];
export class Moment {}
declare function moment(input?: MomentInput): Moment;
export default moment;

export class DataSet<T = unknown> {
  constructor(data?: T[]);
}

export class DataView<T = unknown> {
  constructor(data?: T[]);
}

export interface DataInterface<T = unknown> {
  get(): T[];
}

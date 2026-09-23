/** Common shape every B9 outbound adapter (SAHYOG, NCRP notice sync) implements. */
export interface IntegrationAdapter<TPayload, TResult> {
  submit(payload: TPayload): Promise<TResult>;
}

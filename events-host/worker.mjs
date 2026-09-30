/** Source outage/gap must not starve already imported events or another delivery retry. */
export async function monitorIteration({source,store,service,refreshStatus=true,log=console.error,relay}) {
  const step=async(name,operation)=> {try {await operation();}catch {log(`Print event ${name} step failed; no event cursor is skipped.`);}};
  if(refreshStatus)await step('status',()=>source.readStatus());
  await step('relay',()=>relay(source,store));
  await step('delivery',()=>service.deliverPending());
}

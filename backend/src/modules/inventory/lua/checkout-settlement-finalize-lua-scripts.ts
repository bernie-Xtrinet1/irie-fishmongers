import { settlementProtocol } from '../../reservation-fence/lua/checkout-settlement.lua';

// Exact-manifest committed settlement. All types/accounting are checked before
// the first write; no current-cart scan or legacy restore-active fallback.
export const CHECKOUT_SETTLEMENT_FINALIZE_SCRIPT = settlementProtocol('CHECKOUT_FINALIZE', `
local quantities={}
local entries={}
local seenProducts={}
if not uuid(grant.checkoutIdempotencyKey) or type(s.quantities)~='table' or #s.quantities~=#s.resources then
  return rejected('PERMIT_SCOPE_MISMATCH') end
for _,q in ipairs(s.quantities) do
  if not uuid(q.markerId) or not integer(q.quantity) or q.quantity<1 or quantities[q.markerId] then
    return rejected('PERMIT_SCOPE_MISMATCH') end
  quantities[q.markerId]=q.quantity
end
local cartId=s.resources[1].cartId
local customerId=s.resources[1].customerId
local cartIndex='inv:reserved:cart-index:{'..cartId..'}'
if redis.call('TYPE',cartIndex).ok~='set' then return rejected('RESOURCE_GENERATION_MISMATCH') end
for i,r in ipairs(s.resources) do
  if r.cartId~=cartId or r.customerId~=customerId or seenProducts[r.productId] then
    return rejected('PERMIT_SCOPE_MISMATCH') end
  seenProducts[r.productId]=true
  local key='inv:reserved:{'..cartId..'}:'..r.productId
  local entry,err=read(key)
  if err or entry.version~=1 or entry.status~='CHECKOUT_PENDING' or entry.cartId~=cartId or
    entry.customerId~=customerId or entry.quantity~=quantities[r.markerId] or
    entry.checkoutIdempotencyKey~=grant.checkoutIdempotencyKey or entry.holdInstanceId~=r.holdInstanceId or
    entry.markerId~=r.markerId or entry.generation~=r.generation or entry.reservationExecutionEpoch~=s.epoch or
    entry.checkoutOperationId~=s.execution.operationId or entry.checkoutAttemptId~=s.execution.attemptId then
    return rejected('RESOURCE_GENERATION_MISMATCH') end
  local productIndex='inv:reserved:product-index:{'..r.productId..'}'
  local totalKey='inv:reserved:product-total:{'..r.productId..'}'
  local suspectKey='inv:reserved:product-total-suspect:{'..r.productId..'}'
  if redis.call('TYPE',productIndex).ok~='set' or redis.call('SISMEMBER',cartIndex,r.productId)~=1 or
    redis.call('SISMEMBER',productIndex,cartId)~=1 or redis.call('TYPE',totalKey).ok~='string' then
    return rejected('RESOURCE_GENERATION_MISMATCH') end
  local total=tonumber(redis.call('GET',totalKey))
  if not integer(total) or total<0 then return rejected('RESOURCE_GENERATION_MISMATCH') end
  entries[i]={key=key,productIndex=productIndex,totalKey=totalKey,suspectKey=suspectKey,total=total,quantity=entry.quantity}
end
`, `
for i,r in ipairs(s.resources) do
  local e=entries[i]
  redis.call('DEL',e.key)
  redis.call('SREM',cartIndex,r.productId)
  redis.call('SREM',e.productIndex,cartId)
  if e.total>=e.quantity then redis.call('SET',e.totalKey,e.total-e.quantity)
  else redis.call('SET',e.suspectKey,'1') end
end
`);

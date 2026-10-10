const cents = value => Math.round((Number(value) + Number.EPSILON) * 100);
const money = value => value / 100;

// A dedicated order payment keeps its purpose. General receipts cover game charges first.
export function allocateSessionSettlement(gameAmount, ordersAmount, payments, freeClose) {
  const game = Math.max(0, cents(gameAmount));
  const orders = Math.max(0, cents(ordersAmount));
  const cash = Math.max(0, payments.reduce((sum, payment) => payment.paymentMethod === 'ucretsiz' ? sum : sum + cents(payment.amount), 0));
  const reservedOrders = Math.max(0, payments.reduce((sum, payment) => {
    if (payment.paymentMethod === 'ucretsiz' || payment.amount <= 0) return sum;
    if (payment.kind === 'orders') return sum + cents(payment.amount);
    if (payment.kind === 'partial' && payment.gameCredit != null) return sum + cents(payment.amount - payment.gameCredit);
    return sum;
  }, 0));
  const paidOrdersFirst = Math.min(orders, cash, reservedOrders);
  const paidGame = Math.min(game, cash - paidOrdersFirst);
  const paidOrders = Math.min(orders, cash - paidGame);
  const unallocated = Math.max(0, cash - paidGame - paidOrders);
  return {
    paidGameAmount: money(paidGame),
    paidOrdersAmount: money(paidOrders),
    freeGameAmount: freeClose ? money(game - paidGame) : 0,
    freeOrdersAmount: freeClose ? money(orders - paidOrders) : 0,
    unallocatedAmount: money(unallocated),
  };
}

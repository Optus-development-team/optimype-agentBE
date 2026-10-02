import { atomicToUsdc, usdcToAtomic } from './supplier-payments.config';
import { parsePurchaseIntent } from './supplier-payments.templates';

describe('parsePurchaseIntent', () => {
  it.each([
    ['Quiero comprar 50 bolsas de cemento', 50],
    ['quiero comprar 50 bolsas de cemento', 50],
    ['Necesito 120 bolsas de cemento para la obra', 120],
    ['Compra cincuenta bolsas de cemento', 50],
    ['Pedir cemento', 50],
    ['comprar cemento IP-30 de 50 kg, 20 bolsas', 20],
    ['Cemento 75', 75],
  ])('"%s" → compra de %i bolsas de cemento', (text, quantity) => {
    const intent = parsePurchaseIntent(text);
    expect(intent).toMatchObject({ kind: 'purchase', quantity });
    expect(intent.kind === 'purchase' && intent.product.sku).toBe(
      'CEM-IP30-50',
    );
  });

  it('reconoce una compra de un producto fuera del catálogo', () => {
    expect(parsePurchaseIntent('Quiero comprar 10 ladrillos')).toEqual({
      kind: 'purchase_unknown_product',
    });
  });

  it.each(['Hola', 'buenos días', '¿cómo estás?'])(
    '"%s" no es una compra',
    (text) => {
      expect(parsePurchaseIntent(text)).toEqual({ kind: 'other' });
    },
  );
});

describe('importes USDC', () => {
  it('convierte entre decimal y unidades atómicas de 6 decimales', () => {
    expect(usdcToAtomic('0.01')).toBe(10_000n);
    expect(usdcToAtomic('12.5')).toBe(12_500_000n);
    expect(atomicToUsdc(500_000n)).toBe('0.50');
    expect(atomicToUsdc(1_234_567n)).toBe('1.234567');
    expect(() => usdcToAtomic('0.0000001')).toThrow();
  });
});

/** Esta página verifica os contratos HTTP do painel sem executar regras financeiras locais.
 * Assinatura: Leonardo de Souza da Luz
 */
import { describe, expect, test } from 'bun:test';
import { ApiRequestError, createWageringApi, type WagerRequest } from '../src/api/wagering-api';

describe('cliente HTTP das operações do painel', () => {
  test('envia wagering com dinheiro textual e chave de idempotência no cabeçalho', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const client = createWageringApi(async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return Response.json({ transactionId: 'transacao-1', status: 'PROCESSED', idempotentReplay: false });
    });
    const payload: WagerRequest = {
      providerId: 'provedor-teste',
      externalTransactionId: 'externa-1',
      playerId: 'jogador-1',
      walletId: '11111111-1111-4111-8111-111111111111',
      roundId: 'rodada-1',
      gameId: 'jogo-1',
      kind: 'BET',
      money: { amount: '12.34', currency: 'BRL' },
    };

    await client.submitWager(payload, 'chave-persistente-1');

    expect(capturedUrl).toBe('/api/wagering/transactions');
    expect(new Headers(capturedInit?.headers).get('idempotency-key')).toBe('chave-persistente-1');
    expect(JSON.parse(String(capturedInit?.body))).toEqual(payload);
    expect(JSON.parse(String(capturedInit?.body)).money.amount).toBe('12.34');
  });

  test('preserva código e mensagem de conflito HTTP para exibição ao usuário', async () => {
    const client = createWageringApi(async () => Response.json({
      statusCode: 409,
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'A chave já foi usada com outro conteúdo.',
    }, { status: 409 }));

    const result = client.getWallet('11111111-1111-4111-8111-111111111111');

    await expect(result).rejects.toBeInstanceOf(ApiRequestError);
    await expect(result).rejects.toMatchObject({
      status: 409,
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'A chave já foi usada com outro conteúdo.',
    });
  });

  test('mantém o cursor como parâmetro opaco ao pedir a próxima página', async () => {
    let capturedUrl = '';
    const client = createWageringApi(async (input) => {
      capturedUrl = String(input);
      return Response.json({ items: [], nextCursor: null });
    });
    const cursor = 'eyJjdXJzb3IiOiJhIGIrLyJ9';

    await client.getWalletLedger('11111111-1111-4111-8111-111111111111', cursor);

    const query = new URL(capturedUrl, 'http://painel.local').searchParams;
    expect(query.get('cursor')).toBe(cursor);
    expect(query.get('limit')).toBe('20');
  });
});

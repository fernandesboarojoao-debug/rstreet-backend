const test = require('node:test');
const assert = require('node:assert/strict');
const { validarEnderecoPorCep, normalizarTexto } = require('../src/services/cep');

const endereco = {
  cep: '13720-000',
  rua: 'Avenida Nove de Julho',
  numero: '530',
  bairro: 'Centro',
  cidade: 'Sao Jose do Rio Pardo',
  estado: 'SP',
};

test('CEP valida cidade sem depender de acentos e devolve dados canonicos', async () => {
  const result = await validarEnderecoPorCep(endereco, async () => ({
    ok: true,
    json: async () => ({ localidade: 'São José do Rio Pardo', uf: 'SP' }),
  }));
  assert.equal(result.cep, '13720-000');
  assert.equal(result.cidade, 'São José do Rio Pardo');
  assert.equal(normalizarTexto(result.cidade), 'sao jose do rio pardo');
});

test('CEP rejeita cidade ou estado divergente', async () => {
  await assert.rejects(
    validarEnderecoPorCep({ ...endereco, cidade: 'Campinas' }, async () => ({
      ok: true,
      json: async () => ({ localidade: 'São José do Rio Pardo', uf: 'SP' }),
    })),
    err => err.status === 400 && /nao corresponde/i.test(err.message)
  );
});

test('CEP indisponivel produz erro temporario e nao libera frete gratuito', async () => {
  await assert.rejects(
    validarEnderecoPorCep(endereco, async () => ({ ok: false })),
    err => err.status === 503
  );
});

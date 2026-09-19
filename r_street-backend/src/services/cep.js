function erroEndereco(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

function normalizarTexto(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function validarEnderecoPorCep(endereco = {}, fetchImpl = global.fetch) {
  const cep = String(endereco.cep || '').replace(/\D/g, '');
  if (cep.length !== 8) throw erroEndereco('Informe um CEP valido com 8 digitos.');
  if (typeof fetchImpl !== 'function') throw erroEndereco('Servico de CEP indisponivel.', 503);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetchImpl(`https://viacep.com.br/ws/${cep}/json/`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw erroEndereco('Nao foi possivel validar o CEP agora. Tente novamente.', 503);
    const data = await response.json();
    if (data?.erro || !data?.localidade || !data?.uf) throw erroEndereco('CEP nao encontrado. Confira e tente novamente.');

    const cidadeInformada = normalizarTexto(endereco.cidade);
    const estadoInformado = String(endereco.estado || '').trim().toUpperCase();
    if (cidadeInformada !== normalizarTexto(data.localidade) || estadoInformado !== String(data.uf).toUpperCase()) {
      throw erroEndereco('O CEP nao corresponde a cidade e ao estado informados. Busque o CEP novamente.');
    }

    return {
      ...endereco,
      cep: `${cep.slice(0, 5)}-${cep.slice(5)}`,
      cidade: String(data.localidade).trim(),
      estado: String(data.uf).trim().toUpperCase(),
    };
  } catch (err) {
    if (err?.status) throw err;
    if (err?.name === 'AbortError') throw erroEndereco('A validacao do CEP demorou demais. Tente novamente.', 503);
    throw erroEndereco('Nao foi possivel validar o CEP agora. Tente novamente.', 503);
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { validarEnderecoPorCep, normalizarTexto };

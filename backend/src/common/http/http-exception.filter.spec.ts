import { ArgumentsHost, BadRequestException, HttpException, HttpStatus } from '@nestjs/common';

import { HttpExceptionFilter } from './http-exception.filter';

function createHost(): { host: ArgumentsHost; json: jest.Mock; status: jest.Mock } {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
    }),
  } as unknown as ArgumentsHost;

  return { host, json, status };
}

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
  });

  it('formats a string HttpException response', () => {
    const { host, json, status } = createHost();

    filter.catch(new HttpException('Not found', HttpStatus.NOT_FOUND), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(json).toHaveBeenCalledWith({ success: false, data: null, error: 'Not found' });
  });

  it('joins array validation messages from a BadRequestException', () => {
    const { host, json, status } = createHost();

    filter.catch(new BadRequestException(['field is required', 'field must be a string']), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith({
      success: false,
      data: null,
      error: 'field is required, field must be a string',
    });
  });

  it('falls back to the exception message for an unrecognized response shape', () => {
    const { host, json } = createHost();

    filter.catch(new HttpException({ custom: 'payload' }, HttpStatus.BAD_REQUEST), host);

    expect(json).toHaveBeenCalledWith({
      success: false,
      data: null,
      error: 'Http Exception',
    });
  });

  it('treats unknown thrown values as internal server errors', () => {
    const { host, json, status } = createHost();

    filter.catch(new Error('boom'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({
      success: false,
      data: null,
      error: 'Internal server error',
    });
  });
});

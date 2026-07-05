import { CallHandler, ExecutionContext } from '@nestjs/common';
import { of, firstValueFrom } from 'rxjs';

import { ResponseInterceptor } from './response.interceptor';

describe('ResponseInterceptor', () => {
  const interceptor = new ResponseInterceptor<unknown>();
  const context = {} as ExecutionContext;

  function handlerFor(value: unknown): CallHandler {
    return { handle: () => of(value) };
  }

  it('wraps a value in the success envelope', async () => {
    const result = await firstValueFrom(interceptor.intercept(context, handlerFor({ id: 1 })));

    expect(result).toEqual({ success: true, data: { id: 1 }, error: null });
  });

  it('normalizes undefined responses to null data', async () => {
    const result = await firstValueFrom(interceptor.intercept(context, handlerFor(undefined)));

    expect(result).toEqual({ success: true, data: null, error: null });
  });
});

import Image from 'next/image';
import Link from 'next/link';

const seafood = [
  ['Red snapper', 'red-snapper.png'],
  ['Kingfish', 'king-fish.png'],
  ['Tilapia', 'tilapia.jpg'],
  ['Mackerel', 'mackerel.png'],
  ['Caribbean spiny lobster', 'lobster.png'],
  ['Jumbo shrimp', 'jumbo-shrimp.png'],
] as const;

const deliverySteps = [
  {
    title: 'Choose the vendor’s catch',
    description: 'Order seafood online from a participating vendor.',
    alt: 'Jamaican seafood vendor displaying fresh fish on ice',
  },
  {
    title: 'Refrigerated transport',
    description:
      'For refrigerated delivery, your order travels in temperature-controlled transport.',
    alt: 'Refrigerated delivery truck travelling along a Jamaican coastal road',
  },
  {
    title: 'Receive it at your door',
    description: 'Meet your driver at the delivery address you provided at checkout.',
    alt: 'A customer receiving a sealed seafood order at their front door',
  },
];

export function SeafoodShowcase(): React.ReactElement {
  return (
    <div className="space-y-10">
      <section className="grid overflow-hidden rounded-3xl bg-[#12382e] text-white md:grid-cols-[0.88fr_1.12fr]">
        <div className="flex flex-col justify-center px-7 py-9 sm:px-10 sm:py-12">
          <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            Fresh seafood from Jamaican vendors
          </h1>
          <p className="mt-4 max-w-sm text-sm leading-6 text-emerald-50 sm:text-base">
            Browse today&apos;s catch and compare seafood from local sellers.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-4">
            <Link
              href="#available-today"
              className="rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#12382e] hover:bg-emerald-100"
            >
              Shop today&apos;s catch
            </Link>
            <Link href="/platform" className="text-sm font-medium underline underline-offset-4">
              Sell or deliver with us
            </Link>
          </div>
        </div>
        <div className="relative min-h-56 md:min-h-full">
          <Image
            src="/demo-products/red-snapper.png"
            alt="Whole red snapper on ice"
            fill
            priority
            sizes="(min-width: 1152px) 640px, (min-width: 768px) 56vw, 100vw"
            className="object-cover"
          />
        </div>
      </section>

      <section aria-labelledby="seafood-showcase-heading">
        <h2 id="seafood-showcase-heading" className="text-2xl font-semibold text-gray-900">
          Explore seafood
        </h2>
        <p className="mt-1 text-sm text-gray-600">
          Reference photos. See Available Today for current stock.
        </p>
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
          {seafood.map(([name, image]) => (
            <figure
              key={image}
              className="overflow-hidden rounded-2xl border border-gray-200 bg-white"
            >
              <div className="relative aspect-[3/2] bg-gray-100">
                <Image
                  src={`/demo-products/${image}`}
                  alt=""
                  fill
                  sizes="(min-width: 1152px) 370px, (min-width: 640px) 33vw, 50vw"
                  className="object-cover"
                />
              </div>
              <figcaption className="px-3 py-3 text-sm font-semibold text-gray-900 sm:px-4">
                {name}
              </figcaption>
            </figure>
          ))}
        </div>
        <details className="mt-4 text-sm leading-6 text-gray-600">
          <summary className="cursor-pointer font-medium underline underline-offset-4">
            Photo credits
          </summary>
          <p className="mt-2">
            Jumbo shrimp by{' '}
            <a
              className="underline"
              href="https://commons.wikimedia.org/wiki/File:Penaeus_esculentus-2009.jpg"
            >
              Tamorlan
            </a>
            ,{' '}
            <a className="underline" href="https://creativecommons.org/licenses/by/3.0/">
              CC BY 3.0
            </a>
            . Resized, cropped, and marked with a demo label.
          </p>
          <p>
            <a
              className="underline"
              href="https://commons.wikimedia.org/wiki/File:Tilapia_oreochromis_niloticus_fish.jpg"
            >
              Tilapia
            </a>{' '}
            by Duane Raver, U.S. Fish and Wildlife Service.{' '}
            <a className="underline" href="/demo-products/SOURCES.md">
              All sources and licences
            </a>
            .
          </p>
        </details>
      </section>

      <section aria-labelledby="seafood-delivery-heading">
        <h2 id="seafood-delivery-heading" className="text-2xl font-semibold text-gray-900">
          From today’s catch to your door
        </h2>
        <p className="mt-1 text-sm text-gray-600">
          Choose delivery at checkout where available. Images illustrate the delivery process.
        </p>
        <ol className="mt-5 grid gap-4 sm:grid-cols-3">
          {deliverySteps.map(({ title, description, alt }, index) => (
            <li key={title} className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
              <div className="relative aspect-[4/3] overflow-hidden bg-gray-100">
                <Image
                  src="/seafood-delivery-journey.png"
                  alt={alt}
                  width={2172}
                  height={724}
                  sizes="(min-width: 1152px) 1120px, (min-width: 640px) 100vw, 300vw"
                  className="absolute top-1/2 h-auto w-[300%] max-w-none -translate-y-1/2"
                  style={{ left: `${-100 * index}%` }}
                />
              </div>
              <div className="p-4">
                <h3 className="font-semibold text-gray-900">{title}</h3>
                <p className="mt-1 text-sm leading-6 text-gray-600">{description}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

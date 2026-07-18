import { fireEvent, render, screen } from '@testing-library/react';

import { StarRating } from './star-rating';

describe('StarRating', () => {
  describe('read-only mode', () => {
    it('exposes a single img with a value summary and no radio semantics', () => {
      render(<StarRating value={4.3} readOnly />);
      expect(screen.getByRole('img', { name: 'Rated 4.3 out of 5 stars' })).toBeInTheDocument();
      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
      expect(screen.queryAllByRole('radio')).toHaveLength(0);
    });

    it('is read-only when no onChange is provided even without the flag', () => {
      render(<StarRating value={3} />);
      expect(screen.getByRole('img', { name: 'Rated 3.0 out of 5 stars' })).toBeInTheDocument();
    });
  });

  describe('interactive mode', () => {
    it('renders a radiogroup with one radio per star and marks the selected one', () => {
      render(<StarRating value={2} onChange={jest.fn()} label="Rate this vendor" />);
      const group = screen.getByRole('radiogroup', { name: 'Rate this vendor' });
      expect(group).toBeInTheDocument();
      const radios = screen.getAllByRole('radio');
      expect(radios).toHaveLength(5);
      expect(screen.getByRole('radio', { name: '2 stars' })).toHaveAttribute('aria-checked', 'true');
    });

    it('gives the selected star the only tab stop (roving tabindex)', () => {
      render(<StarRating value={3} onChange={jest.fn()} />);
      expect(screen.getByRole('radio', { name: '3 stars' })).toHaveAttribute('tabindex', '0');
      expect(screen.getByRole('radio', { name: '1 star' })).toHaveAttribute('tabindex', '-1');
    });

    it('selects a star on click', () => {
      const onChange = jest.fn();
      render(<StarRating value={0} onChange={onChange} />);
      fireEvent.click(screen.getByRole('radio', { name: '4 stars' }));
      expect(onChange).toHaveBeenCalledWith(4);
    });

    it('moves selection with arrow keys and clamps at the bounds', () => {
      const onChange = jest.fn();
      const { rerender } = render(<StarRating value={3} onChange={onChange} />);
      fireEvent.keyDown(screen.getByRole('radio', { name: '3 stars' }), { key: 'ArrowRight' });
      expect(onChange).toHaveBeenLastCalledWith(4);

      rerender(<StarRating value={5} onChange={onChange} />);
      fireEvent.keyDown(screen.getByRole('radio', { name: '5 stars' }), { key: 'ArrowRight' });
      expect(onChange).toHaveBeenLastCalledWith(5); // clamped at max
    });

    it('confirms with Space/Enter', () => {
      const onChange = jest.fn();
      render(<StarRating value={0} onChange={onChange} />);
      fireEvent.keyDown(screen.getByRole('radio', { name: '2 stars' }), { key: ' ' });
      expect(onChange).toHaveBeenCalledWith(2);
    });
  });
});

public class Main {
    public static void main(String[] args) {
        if (multiply(6, 7) != 42) throw new AssertionError("Java assertion failed");
        System.out.println("Java smoke test passed");
    }

    private static int multiply(int left, int right) {
        return left * right;
    }
}

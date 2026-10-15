package main

import "fmt"

func main() {
    if 6*7 != 42 {
        panic("Go assertion failed")
    }
    fmt.Println("Go smoke test passed")
}
